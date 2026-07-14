#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { isActiveJobStatus, sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const STOP_REVIEW_AVAILABILITY_TIMEOUT_MS = 5 * 1000;
const STOP_REVIEW_ATTACH_TIMEOUT_MS = 13 * 60 * 1000;
const STOP_REVIEW_TASK_TIMEOUT_MS = STOP_REVIEW_ATTACH_TIMEOUT_MS + 30 * 1000;
const STOP_REVIEW_CANCEL_TIMEOUT_MS = 10 * 1000;
const STOP_REVIEW_CLEANUP_TIMEOUT_MS =
  STOP_REVIEW_TIMEOUT_MS - STOP_REVIEW_TASK_TIMEOUT_MS - STOP_REVIEW_CANCEL_TIMEOUT_MS - 15 * 1000;
const STOP_REVIEW_CLEANUP_GRACE_MS = 5 * 1000;
const STOP_REVIEW_POST_TASK_BUDGET_MS =
  STOP_REVIEW_CANCEL_TIMEOUT_MS + STOP_REVIEW_CLEANUP_TIMEOUT_MS + STOP_REVIEW_CLEANUP_GRACE_MS + 10 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const COMPANION_SCRIPT = path.join(SCRIPT_DIR, "codex-companion.mjs");
const CODEX_MODULE_URL = new URL("./lib/codex.mjs", import.meta.url).href;
const CODEX_AVAILABILITY_SCRIPT = `import { getCodexAvailability } from ${JSON.stringify(CODEX_MODULE_URL)};
process.stdout.write(JSON.stringify(getCodexAvailability(process.argv[1])));`;
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function boundedTimeout(deadline, maximum) {
  return Math.max(1, Math.min(maximum, deadline - Date.now()));
}

function buildSetupNote(cwd, deadline) {
  if (Date.now() >= deadline) {
    return "Codex is not set up for the review gate. The availability check exceeded the 15-minute gate. Run /codex:setup.";
  }
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", CODEX_AVAILABILITY_SCRIPT, cwd],
    {
      cwd,
      env: process.env,
      encoding: "utf8",
      timeout: boundedTimeout(deadline, STOP_REVIEW_AVAILABILITY_TIMEOUT_MS)
    }
  );
  let availability;
  if (result.error?.code === "ETIMEDOUT") {
    availability = { available: false, detail: "availability check timed out" };
  } else if (result.status !== 0) {
    availability = {
      available: false,
      detail: String(result.stderr || result.stdout || result.error?.message || "availability check failed").trim()
    };
  } else {
    try {
      availability = JSON.parse(result.stdout);
    } catch {
      availability = { available: false, detail: "availability check returned invalid JSON" };
    }
  }
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /codex:review --wait manually or bypass the gate."
  };
}

function isStopReviewJob(job) {
  return (
    job.title === "Codex Stop Gate Review" ||
    String(job.request?.prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)
  );
}

function cleanupTimedOutStopReview(cwd, childEnv, jobId, deadline) {
  if (Date.now() >= deadline) {
    return `Cleanup for ${jobId} could not be requested before the 15-minute gate expired. Run /codex:status ${jobId}.`;
  }
  const cancelled = spawnSync(process.execPath, [COMPANION_SCRIPT, "cancel", jobId, "--json"], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: boundedTimeout(deadline, STOP_REVIEW_CANCEL_TIMEOUT_MS)
  });
  let cleanupStatus = null;
  try {
    cleanupStatus = JSON.parse(cancelled.stdout)?.status ?? null;
  } catch {
    // Status confirmation below remains authoritative.
  }

  const cleanupWaitTimeout = Math.min(
    STOP_REVIEW_CLEANUP_TIMEOUT_MS,
    deadline - Date.now() - STOP_REVIEW_CLEANUP_GRACE_MS
  );
  if (cleanupStatus !== "cancelled" && cleanupWaitTimeout > 0) {
    const cleanup = spawnSync(
      process.execPath,
      [
        COMPANION_SCRIPT,
        "status",
        jobId,
        "--wait",
        "--timeout-ms",
        String(cleanupWaitTimeout),
        "--json"
      ],
      {
        cwd,
        env: childEnv,
        encoding: "utf8",
        timeout: boundedTimeout(deadline, cleanupWaitTimeout + STOP_REVIEW_CLEANUP_GRACE_MS)
      }
    );
    try {
      cleanupStatus = JSON.parse(cleanup.stdout)?.job?.status ?? cleanupStatus;
    } catch {
      // The cancellation command may still have recorded a terminating job.
    }
  }

  if (cleanupStatus === "terminating") {
    return `Cancellation is recorded for ${jobId} with status terminating; a later stop will not start a duplicate review.`;
  }
  if (cleanupStatus && isActiveJobStatus(cleanupStatus)) {
    return `Cleanup for ${jobId} could not be confirmed because it remains ${cleanupStatus}. A later stop will not start a duplicate review; run /codex:status ${jobId}.`;
  }
  return cleanupStatus
    ? `Cleanup for ${jobId} completed with status ${cleanupStatus}.`
    : `Cleanup for ${jobId} could not be confirmed. Run /codex:status ${jobId} before retrying the stop.`;
}

function runStopReview(cwd, input, deadline) {
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const taskCommandTimeout = Math.floor(
    Math.min(STOP_REVIEW_TASK_TIMEOUT_MS, deadline - Date.now() - STOP_REVIEW_POST_TASK_BUDGET_MS)
  );
  const attachTimeout = Math.min(
    STOP_REVIEW_ATTACH_TIMEOUT_MS,
    taskCommandTimeout - (STOP_REVIEW_TASK_TIMEOUT_MS - STOP_REVIEW_ATTACH_TIMEOUT_MS)
  );
  if (attachTimeout <= 0) {
    return {
      ok: false,
      reason: "The stop-time Codex review could not start before the 15-minute gate deadline."
    };
  }
  const result = spawnSync(
    process.execPath,
    [COMPANION_SCRIPT, "task", "--json", "--timeout-ms", String(attachTimeout), prompt],
    {
      cwd,
      env: childEnv,
      encoding: "utf8",
      timeout: taskCommandTimeout
    }
  );

  if (result.error?.code === "ETIMEDOUT") {
    const runningStopReview = sortJobsNewestFirst(
      filterJobsForCurrentSession(listJobs(resolveWorkspaceRoot(cwd)), input)
    ).find((job) => isActiveJobStatus(job.status) && isStopReviewJob(job));
    const cleanupDetail = runningStopReview
      ? cleanupTimedOutStopReview(cwd, childEnv, runningStopReview.id, deadline)
      : "No active stop-review job was found for cleanup. Run /codex:status before retrying the stop.";
    return {
      ok: false,
      reason:
        `The stop-time Codex review task timed out while reserving cleanup time inside the 15-minute gate. ${cleanupDetail}`
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Codex review task failed: ${detail}`
        : "The stop-time Codex review task failed. Run /codex:review --wait manually or bypass the gate."
    };
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned invalid JSON. Run /codex:review --wait manually or bypass the gate."
    };
  }

  if (payload?.waitTimedOut) {
    const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
    if (!jobId) {
      return {
        ok: false,
        reason:
          "The stop-time Codex review task timed out without a job id, so cleanup could not be requested. Run /codex:status before retrying the stop."
      };
    }

    return {
      ok: false,
      reason: `The stop-time Codex review task timed out. ${cleanupTimedOutStopReview(cwd, childEnv, jobId, deadline)}`
    };
  }

  return parseStopReviewOutput(payload?.rawOutput);
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => isActiveJobStatus(job.status));
  const runningStopReview = jobs.find(
    (job) => isActiveJobStatus(job.status) && isStopReviewJob(job)
  );
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const deadline = Date.now() + STOP_REVIEW_TIMEOUT_MS;
  const setupNote = buildSetupNote(cwd, deadline);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  if (runningStopReview) {
    emitDecision({
      decision: "block",
      reason: `Codex stop-time review task ${runningStopReview.id} is still ${runningStopReview.status}. Wait for cleanup or run /codex:status ${runningStopReview.id}; a duplicate review was not started.`
    });
    return;
  }

  const review = runStopReview(cwd, input, deadline);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
