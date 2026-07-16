#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    archiveAppServerThread,
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, probeProcess, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  updateState,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const MAX_STATUS_WAIT_TIMEOUT_MS = 21600000;
const TURN_INTERRUPT_TIMEOUT_MS = 1000;
const TASK_WORKER_HANDSHAKE_TIMEOUT_MS = 5000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const BUILT_IN_TASK_ROUTES = {
  mechanical: { model: "gpt-5.6-luna", effort: "low" },
  research: { model: "gpt-5.6-terra", effort: "medium" },
  implementation: { model: "gpt-5.6-sol", effort: "high" },
  hard: { model: "gpt-5.6-sol", effort: "xhigh" },
  architecture: { model: "gpt-5.6-sol", effort: "max" },
  parallel: { model: "gpt-5.6-sol", effort: "max" }
};

if (process.platform !== "win32") {
  process.umask(0o077);
}
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const AMBIGUOUS_ACTIVE_TASKS_ERROR =
  "Multiple Codex tasks are active for this session. Use /codex:status with a job id instead of guessing which task to attach.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--route <name> [--model <id>] [--effort <level>]|--route <name> --clear] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--wait|--background] [--write] [--resume-last|--resume|--fresh] [--route <name>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh, max, ultra.`
    );
  }
  return normalized;
}

function normalizeRouteName(route) {
  const normalized = String(route ?? "").trim();
  if (!normalized) {
    throw new Error("A task route name is required.");
  }
  return normalized;
}

function validateTaskRouteOverride(name, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    throw new Error(`Invalid task route configuration for "${name}".`);
  }
  for (const key of Object.keys(override)) {
    if (key !== "model" && key !== "effort") {
      throw new Error(`Invalid task route configuration for "${name}".`);
    }
  }
  if (Object.hasOwn(override, "model") && (typeof override.model !== "string" || !override.model.trim())) {
    throw new Error(`Invalid task route model for "${name}".`);
  }
  if (Object.hasOwn(override, "effort") && (typeof override.effort !== "string" || !override.effort.trim())) {
    throw new Error(`Invalid task route effort for "${name}".`);
  }
  return {
    ...(Object.hasOwn(override, "model") ? { model: normalizeRequestedModel(override.model) } : {}),
    ...(Object.hasOwn(override, "effort") ? { effort: normalizeReasoningEffort(override.effort) } : {})
  };
}

function resolveTaskRoute(config, routeName) {
  const taskRoutes = config.taskRoutes;
  if (!taskRoutes || typeof taskRoutes !== "object" || Array.isArray(taskRoutes)) {
    throw new Error("Invalid task route configuration.");
  }
  const hasOverride = Object.hasOwn(taskRoutes, routeName);
  const override = hasOverride ? validateTaskRouteOverride(routeName, taskRoutes[routeName]) : null;
  const hasBuiltIn = Object.hasOwn(BUILT_IN_TASK_ROUTES, routeName);
  const builtIn = hasBuiltIn ? BUILT_IN_TASK_ROUTES[routeName] : null;
  if (!builtIn && !hasOverride) {
    throw new Error(`Unknown task route "${routeName}".`);
  }
  if (!builtIn && !override.model && !override.effort) {
    throw new Error(`Custom task route "${routeName}" must define a model or effort.`);
  }
  return {
    model: override?.model ?? builtIn?.model ?? null,
    effort: override?.effort ?? builtIn?.effort ?? null
  };
}

function resolveTaskSettings(config, options, resumeRequest = null) {
  const routeName = Object.hasOwn(options, "route") ? normalizeRouteName(options.route) : null;
  const explicitModel = Object.hasOwn(options, "model") ? normalizeRequestedModel(options.model) : null;
  const explicitEffort = Object.hasOwn(options, "effort") ? normalizeReasoningEffort(options.effort) : null;
  const route = routeName ? resolveTaskRoute(config, routeName) : null;

  return {
    model: explicitModel ?? route?.model ?? resumeRequest?.model ?? null,
    effort: explicitEffort ?? route?.effort ?? resumeRequest?.effort ?? null
  };
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createWorkerLease(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const probe = probeProcess(pid);
  return probe.liveness === "alive" && probe.startIdentity ? { pid, startIdentity: probe.startIdentity } : null;
}

function workerLeasesMatch(left, right) {
  return left?.pid === right?.pid && left?.startIdentity === right?.startIdentity;
}

function probeWorkerLease(workerLease) {
  if (
    !workerLease ||
    !Number.isInteger(workerLease.pid) ||
    workerLease.pid <= 0 ||
    typeof workerLease.startIdentity !== "string" ||
    !workerLease.startIdentity
  ) {
    return "unknown";
  }
  const probe = probeProcess(workerLease.pid);
  if (probe.liveness !== "alive") {
    return probe.liveness;
  }
  return probe.startIdentity === workerLease.startIdentity ? "alive" : probe.startIdentity ? "replaced" : "unknown";
}

function cancellationEndpoint(nonce) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\codex-companion-${nonce}`
    : path.join(os.tmpdir(), `codex-companion-${nonce}.sock`);
}

function createWorkerCancellationControl() {
  const token = randomUUID();
  const tokenBytes = Buffer.from(token);
  const endpoint = cancellationEndpoint(randomUUID());
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    const timeout = setTimeout(() => socket.destroy(), TURN_INTERRUPT_TIMEOUT_MS);
    timeout.unref();
    socket.once("close", () => {
      clearTimeout(timeout);
      sockets.delete(socket);
    });

    let request = Buffer.alloc(0);
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) {
        return;
      }
      if (request.length + chunk.length > tokenBytes.length) {
        handled = true;
        socket.end("denied");
        return;
      }
      request = Buffer.concat([request, chunk]);
    });
    socket.on("end", () => {
      if (handled) {
        return;
      }
      handled = true;
      if (request.length !== tokenBytes.length || !timingSafeEqual(request, tokenBytes)) {
        socket.end("denied");
        return;
      }
      socket.end("accepted", () => {
        server.close();
        for (const activeSocket of sockets) {
          if (activeSocket !== socket) {
            activeSocket.destroy();
          }
        }
        setImmediate(() => {
          terminateProcessTree(process.pid);
        });
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      try {
        if (process.platform !== "win32") {
          fs.chmodSync(endpoint, 0o600);
        }
      } catch (error) {
        server.close(() => {
          try {
            fs.unlinkSync(endpoint);
          } catch (unlinkError) {
            if (unlinkError?.code !== "ENOENT") {
              reject(unlinkError);
              return;
            }
          }
          reject(error);
        });
        return;
      }
      server.unref();
      resolve({
        control: { endpoint, token },
        close() {
          return new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
                closeReject(error);
                return;
              }
              if (process.platform !== "win32") {
                try {
                  fs.unlinkSync(endpoint);
                } catch (error) {
                  if (error?.code !== "ENOENT") {
                    closeReject(error);
                    return;
                  }
                }
              }
              closeResolve();
            });
            for (const socket of sockets) {
              socket.destroy();
            }
          });
        }
      });
    });
  });
}

function requestWorkerCancellation(control) {
  if (
    !control ||
    typeof control.endpoint !== "string" ||
    !control.endpoint ||
    typeof control.token !== "string" ||
    !control.token
  ) {
    return Promise.resolve({ delivered: false, detail: "Worker does not expose identity-bound cancellation control." });
  }

  return new Promise((resolve) => {
    const socket = net.createConnection(control.endpoint);
    let response = "";
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(
      () => finish({ delivered: false, detail: `Worker cancellation control timed out after ${TURN_INTERRUPT_TIMEOUT_MS}ms.` }),
      TURN_INTERRUPT_TIMEOUT_MS
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(control.token));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () =>
      finish(
        response === "accepted"
          ? { delivered: true, detail: null }
          : { delivered: false, detail: `Worker rejected the cancellation request (${JSON.stringify(response)}).` }
      )
    );
    socket.once("error", (error) => finish({ delivered: false, detail: error.message }));
  });
}

async function interruptAppServerTurnBounded(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return interruptAppServerTurn(cwd, { threadId, turnId });
  }

  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(
        `const { parentPort, workerData } = require("node:worker_threads");
import(workerData.moduleUrl)
  .then(({ interruptAppServerTurn }) => interruptAppServerTurn(workerData.cwd, workerData.turn))
  .then((result) => parentPort.postMessage(result))
  .catch((error) => parentPort.postMessage({ attempted: true, interrupted: false, transport: null, detail: error instanceof Error ? error.message : String(error) }));`,
        {
          eval: true,
          workerData: {
            cwd,
            moduleUrl: new URL("./lib/codex.mjs", import.meta.url).href,
            turn: { threadId, turnId }
          }
        }
      );
    } catch (error) {
      resolve({
        attempted: true,
        interrupted: false,
        transport: null,
        detail: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      worker.unref?.();
      void worker.terminate().catch(() => {});
      resolve(result);
    };
    worker.once("message", finish);
    worker.once("error", (error) =>
      finish({
        attempted: true,
        interrupted: false,
        transport: null,
        detail: error instanceof Error ? error.message : String(error)
      })
    );
    worker.once("exit", (code) => {
      if (!settled) {
        finish({
          attempted: true,
          interrupted: false,
          transport: null,
          detail: `Turn interrupt worker exited with status ${code}.`
        });
      }
    });
    timer = setTimeout(
      () =>
        finish({
          attempted: true,
          interrupted: false,
          transport: null,
          detail: `timed out after ${TURN_INTERRUPT_TIMEOUT_MS}ms`
        }),
      TURN_INTERRUPT_TIMEOUT_MS
    );
  });
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "route", "model", "effort"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "clear"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }
  if (options.clear && !Object.hasOwn(options, "route")) {
    throw new Error("`--clear` requires `--route <name>`.");
  }
  if (options.clear && (Object.hasOwn(options, "model") || Object.hasOwn(options, "effort"))) {
    throw new Error("`--clear` cannot be combined with `--model` or `--effort`.");
  }
  if (!Object.hasOwn(options, "route") && (Object.hasOwn(options, "model") || Object.hasOwn(options, "effort"))) {
    throw new Error("`--model` and `--effort` require `--route <name>`.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];
  const config = getConfig(workspaceRoot);
  const nextConfig = { ...config };

  if (options["enable-review-gate"]) {
    nextConfig.stopReviewGate = true;
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    nextConfig.stopReviewGate = false;
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  if (Object.hasOwn(options, "route")) {
    const routeName = normalizeRouteName(options.route);
    const taskRoutes = config.taskRoutes;
    if (!taskRoutes || typeof taskRoutes !== "object" || Array.isArray(taskRoutes)) {
      throw new Error("Invalid task route configuration.");
    }

    if (options.clear) {
      const nextRoutes = { ...taskRoutes };
      delete nextRoutes[routeName];
      nextConfig.taskRoutes = nextRoutes;
      actionsTaken.push(`Cleared the task route override for ${routeName}.`);
    } else {
      const override = Object.hasOwn(taskRoutes, routeName)
        ? validateTaskRouteOverride(routeName, taskRoutes[routeName])
        : {};
      if (Object.hasOwn(options, "model")) {
        const model = normalizeRequestedModel(options.model);
        if (!model) {
          throw new Error("A task route model is required.");
        }
        override.model = model;
      }
      if (Object.hasOwn(options, "effort")) {
        const effort = normalizeReasoningEffort(options.effort);
        if (!effort) {
          throw new Error("A task route effort is required.");
        }
        override.effort = effort;
      }
      if (!Object.hasOwn(BUILT_IN_TASK_ROUTES, routeName) && !override.model && !override.effort) {
        throw new Error(`Custom task route "${routeName}" must define a model or effort.`);
      }
      nextConfig.taskRoutes = {
        ...taskRoutes,
        [routeName]: override
      };
      actionsTaken.push(`Configured the task route override for ${routeName}.`);
    }
  }

  if (actionsTaken.length > 0) {
    updateState(workspaceRoot, (state) => {
      state.config = nextConfig;
    });
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running" || status === "terminating";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        !isActiveJobStatus(job.status)
    ) ?? null
  );
}

function findActiveTaskJobs(jobs) {
  return jobs.filter((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
}

function terminalOwnedByLease(job, workerLease) {
  return (
    job &&
    ["completed", "failed"].includes(job.status) &&
    workerLease &&
    workerLeasesMatch(job.ownerLease, workerLease)
  );
}

function leasesUnchanged(current, observed) {
  return (
    current.status === observed.status &&
    ((!current.workerLease && !observed.workerLease) || workerLeasesMatch(current.workerLease, observed.workerLease)) &&
    ((!current.launcherLease && !observed.launcherLease) || workerLeasesMatch(current.launcherLease, observed.launcherLease))
  );
}

function buildReconciledSingleJobSnapshot(cwd, reference) {
  const snapshot = buildSingleJobSnapshot(cwd, reference);
  if (!isActiveJobStatus(snapshot.job.status)) {
    return snapshot;
  }

  const observed = snapshot.job;
  let observedTerminal = null;
  try {
    const stored = readStoredJob(snapshot.workspaceRoot, observed.id);
    if (terminalOwnedByLease(stored, observed.workerLease)) {
      observedTerminal = stored;
    }
  } catch {
    // The locked revalidation below decides whether the job can be repaired.
  }
  let liveness = null;
  if (!observedTerminal) {
    if (observed.workerLease) {
      liveness = probeWorkerLease(observed.workerLease);
    } else if (observed.status === "queued") {
      liveness = observed.launcherLease ? probeWorkerLease(observed.launcherLease) : "gone";
    }
    if (liveness == null || liveness === "alive" || liveness === "unknown") {
      return snapshot;
    }
  }

  let reconciledJob = null;
  updateState(snapshot.workspaceRoot, (state) => {
    const index = state.jobs.findIndex((job) => job.id === observed.id);
    if (index === -1 || !isActiveJobStatus(state.jobs[index].status) || !leasesUnchanged(state.jobs[index], observed)) {
      return;
    }
    const current = state.jobs[index];
    let stored = null;
    try {
      stored = readStoredJob(snapshot.workspaceRoot, current.id);
    } catch {
      // Repair an unreadable active job file from the locked record below.
    }
    if (terminalOwnedByLease(stored, current.workerLease)) {
      reconciledJob = {
        ...current,
        status: stored.status,
        threadId: stored.threadId ?? null,
        turnId: stored.turnId ?? null,
        summary: stored.summary ?? current.summary,
        phase: stored.phase,
        pid: null,
        completedAt: stored.completedAt,
        ...(stored.errorMessage ? { errorMessage: stored.errorMessage } : {}),
        ...(typeof stored.threadArchived === "boolean" ? { threadArchived: stored.threadArchived } : {}),
        ...(stored.threadArchiveError ? { threadArchiveError: stored.threadArchiveError } : {}),
        updatedAt: stored.completedAt
      };
      state.jobs[index] = reconciledJob;
      return;
    }
    if (liveness == null) {
      return;
    }
    const completedAt = nowIso();
    const cancelled = current.status === "terminating";
    const missingWorkerLease = current.status === "queued" && !current.workerLease;
    reconciledJob = {
      ...current,
      status: cancelled ? "cancelled" : "failed",
      phase: cancelled ? "cancelled" : "failed",
      pid: null,
      completedAt,
      ...(cancelled ? { cancelledAt: completedAt } : {}),
      errorMessage: cancelled
        ? "Cancelled by user."
        : missingWorkerLease
          ? "Task launcher exited before publishing a worker lease."
          : `Task worker ${current.workerLease.pid} exited before completion.`,
      updatedAt: completedAt
    };
    writeJobFile(snapshot.workspaceRoot, current.id, { ...(stored ?? {}), ...reconciledJob });
    state.jobs[index] = reconciledJob;
  });

  if (!reconciledJob) {
    return snapshot;
  }
  return buildSingleJobSnapshot(cwd, snapshot.job.id);
}

function resolveWaitMilliseconds(value, name, defaultValue, minimum = 0) {
  if (value == null) {
    return defaultValue;
  }
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_STATUS_WAIT_TIMEOUT_MS) {
    throw new Error(`${name} must be a finite number from 0 through ${MAX_STATUS_WAIT_TIMEOUT_MS}.`);
  }
  return Math.max(minimum, milliseconds);
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = resolveWaitMilliseconds(
    options.timeoutMs,
    "timeout-ms",
    DEFAULT_STATUS_WAIT_TIMEOUT_MS
  );
  const pollIntervalMs = resolveWaitMilliseconds(
    options.pollIntervalMs,
    "poll-interval-ms",
    DEFAULT_STATUS_POLL_INTERVAL_MS,
    100
  );
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildReconciledSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildReconciledSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = findActiveTaskJobs(visibleJobs)[0];
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return {
      id: trackedTask.threadId,
      request: trackedTask.request ?? null,
      threadArchived: trackedTask.threadArchived === true
    };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  let unarchiveThread = false;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
    unarchiveThread = latestThread.threadArchived === true;
    Object.assign(request, resolveTaskSettings(getConfig(workspaceRoot), request, latestThread.request));
    const resolvedRequest = buildTaskRequest(request);
    upsertJob(workspaceRoot, {
      id: request.jobId,
      request: resolvedRequest
    });
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(request.cwd, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    config: request.write ? { features: { multi_agent: false } } : null,
    directAppServer: true,
    onProgress: request.onProgress,
    persistThread: true,
    archiveThread: true,
    shouldArchiveThread: () =>
      listJobs(workspaceRoot).some(
        (job) => job.id === request.jobId && job.status === "running" && job.pid === process.pid
      ),
    ...(unarchiveThread ? { unarchiveThread: true } : {}),
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    threadArchived: result.threadArchived,
    ...(result.threadArchiveError ? { threadArchiveError: result.threadArchiveError } : {})
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    threadArchived: result.threadArchived,
    ...(result.threadArchiveError ? { threadArchiveError: result.threadArchiveError } : {}),
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id, {
        preclaimedPid: options.preclaimedPid
      })
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const workerLease = createWorkerLease(process.pid);
  if (!workerLease) {
    throw new Error(`Could not record start identity for review worker ${process.pid}.`);
  }
  const cancellation = await createWorkerCancellationControl();
  try {
    const trackedJob = { ...job, pid: process.pid, workerLease, cancelControl: cancellation.control };
    const { logFile, progress } = createTrackedProgress(trackedJob, {
      logFile: options.logFile,
      stderr: !options.json
    });
    const execution = await runTrackedJob(trackedJob, () => runner(progress), { logFile });
    outputResult(options.json ? execution.payload : execution.rendered, options.json);
    if (execution.exitStatus !== 0) {
      process.exitCode = execution.exitStatus;
    }
    return execution;
  } finally {
    await cancellation.close();
  }
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true
    });
    const timeout = setTimeout(() => {
      fail(new Error(`Task worker did not provide a valid lease handshake within ${TASK_WORKER_HANDSHAKE_TIMEOUT_MS}ms.`));
    }, TASK_WORKER_HANDSHAKE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("message", onMessage);
    };
    const fail = (error) => {
      cleanup();
      try {
        if (child.connected) {
          child.disconnect();
        }
        terminateProcessTree(child.pid, {
          cwd,
          env: process.env,
          timeout: TASK_WORKER_HANDSHAKE_TIMEOUT_MS
        });
        child.unref();
      } catch (cleanupError) {
        const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        reject(new Error(`${error.message} Failed to terminate task worker: ${detail}`, { cause: cleanupError }));
        return;
      }
      reject(error);
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) => {
      fail(new Error(`Task worker exited before its lease handshake (${signal ?? `exit ${code}`}).`));
    };
    const onMessage = (message) => {
      if (
        message?.type !== "worker-lease" ||
        !Number.isInteger(message.workerLease?.pid) ||
        message.workerLease.pid <= 0 ||
        typeof message.workerLease.startIdentity !== "string" ||
        !message.workerLease.startIdentity ||
        !message.cancelControl?.endpoint ||
        !message.cancelControl?.token
      ) {
        fail(new Error("Task worker sent an invalid lease handshake."));
        return;
      }
      cleanup();
      if (child.connected) {
        child.disconnect();
      }
      child.unref();
      resolve({ workerLease: message.workerLease, cancelControl: message.cancelControl });
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("message", onMessage);
  });
}

async function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");
  const launcherLease = createWorkerLease(process.pid);
  if (!launcherLease) {
    throw new Error(`Could not record start identity for task launcher ${process.pid}.`);
  }

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    launcherLease,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);
  try {
    const { workerLease, cancelControl } = await spawnDetachedTaskWorker(cwd, job.id);
    updateState(job.workspaceRoot, (state) => {
      const index = state.jobs.findIndex((candidate) => candidate.id === job.id);
      if (
        index === -1 ||
        (state.jobs[index].status !== "queued" &&
          !(state.jobs[index].status === "running" && workerLeasesMatch(state.jobs[index].workerLease, workerLease)))
      ) {
        return;
      }
      const stored = readStoredJob(job.workspaceRoot, job.id);
      if (!stored || !isActiveJobStatus(stored.status)) {
        return;
      }
      const leasedRecord = {
        ...state.jobs[index],
        pid: workerLease.pid,
        workerLease,
        cancelControl,
        launcherLease: null,
        updatedAt: nowIso()
      };
      writeJobFile(job.workspaceRoot, job.id, { ...stored, ...leasedRecord });
      state.jobs[index] = leasedRecord;
    });
  } catch (error) {
    const errorMessage = `Failed to start detached task worker for ${job.id}: ${error instanceof Error ? error.message : String(error)}`;
    const completedAt = nowIso();
    let failedRecord = null;
    updateState(job.workspaceRoot, (state) => {
      const index = state.jobs.findIndex(
        (candidate) =>
          candidate.id === job.id &&
          candidate.status === "queued" &&
          workerLeasesMatch(candidate.launcherLease, launcherLease)
      );
      if (index === -1) {
        return;
      }
      failedRecord = {
        ...state.jobs[index],
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage,
        completedAt
      };
      writeJobFile(job.workspaceRoot, job.id, {
        ...(readStoredJob(job.workspaceRoot, job.id) ?? {}),
        ...failedRecord
      });
      state.jobs[index] = failedRecord;
    });
    if (failedRecord) {
      appendLogLine(logFile, errorMessage);
    }
    throw new Error(errorMessage, { cause: error });
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function publishTaskWorkerHandshake(workerLease, cancelControl) {
  if (typeof process.send !== "function") {
    return;
  }
  await new Promise((resolve) => {
    process.send({ type: "worker-lease", workerLease, cancelControl }, () => resolve());
  });
  if (process.connected) {
    process.disconnect();
  }
}

async function attachTaskJob(cwd, jobId, options = {}) {
  const snapshot = await waitForSingleJobSnapshot(cwd, jobId, {
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs ?? 100
  });

  if (snapshot.waitTimedOut) {
    const payload = {
      jobId: snapshot.job.id,
      status: snapshot.job.status,
      title: snapshot.job.title ?? null,
      summary: snapshot.job.summary ?? null,
      logFile: snapshot.job.logFile ?? null,
      waitTimedOut: true,
      timeoutMs: snapshot.timeoutMs
    };
    const rendered = `${renderJobStatusReport(snapshot.job)}\njobId: ${payload.jobId}\nstatus: ${payload.status}\nwaitTimedOut: true\n`;
    outputCommandResult(payload, rendered, options.json);
    return;
  }

  const storedJob = readStoredJob(snapshot.workspaceRoot, snapshot.job.id);
  if (!storedJob?.rendered || !Object.hasOwn(storedJob, "result")) {
    throw new Error(storedJob?.errorMessage ?? `Task ${snapshot.job.id} finished without a stored result.`);
  }

  outputResult(options.json ? storedJob.result : storedJob.rendered, options.json);
  if (snapshot.job.status !== "completed") {
    process.exitCode = 1;
  }
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["route", "model", "effort", "cwd", "prompt-file", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }

  if (options.wait && resumeLast && !options.background) {
    const sessionId = getCurrentClaudeSessionId();
    const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) =>
      sessionId ? job.sessionId === sessionId : !job.sessionId
    );
    const activeTasks = findActiveTaskJobs(jobs);
    if (activeTasks.length > 1) {
      throw new Error(AMBIGUOUS_ACTIVE_TASKS_ERROR);
    }
    if (activeTasks.length === 1) {
      await attachTaskJob(cwd, activeTasks[0].id, {
        json: options.json,
        timeoutMs: options["timeout-ms"],
        pollIntervalMs: options["poll-interval-ms"]
      });
      return;
    }
  }

  const { model, effort } = resolveTaskSettings(getConfig(workspaceRoot), options);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  ensureCodexAvailable(cwd);
  requireTaskRequest(prompt, resumeLast);

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  const request = buildTaskRequest({
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId: job.id
  });
  job.request = request;
  const { payload } = await enqueueBackgroundTask(cwd, job, request);
  if (options.background) {
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await attachTaskJob(cwd, job.id, {
    json: options.json,
    timeoutMs: options["timeout-ms"],
    pollIntervalMs: options["poll-interval-ms"]
  });
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

function finalizeTaskWorkerFailure(workspaceRoot, jobId, error) {
  const errorMessage = `Task worker ${jobId} failed before execution: ${error instanceof Error ? error.message : String(error)}`;
  const completedAt = nowIso();
  let failedJob = null;
  updateState(workspaceRoot, (state) => {
    const index = state.jobs.findIndex(
      (job) => job.id === jobId && (job.status === "queued" || (job.status === "running" && job.pid === process.pid))
    );
    if (index === -1) {
      return;
    }
    const current = state.jobs[index];
    failedJob = {
      ...current,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    };
    writeJobFile(workspaceRoot, jobId, {
      ...(readStoredJob(workspaceRoot, jobId) ?? {}),
      ...failedJob
    });
    state.jobs[index] = failedJob;
  });
  if (!failedJob) {
    return error instanceof Error ? error : new Error(String(error));
  }
  try {
    appendLogLine(failedJob.logFile, errorMessage);
  } catch {
    // Preserve the startup failure when its log path is unusable.
  }
  return new Error(errorMessage, { cause: error });
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const jobId = options["job-id"];
  let claimedJob = null;
  let tracking = null;
  let cancellation = null;
  let workerLease = null;
  try {
    workerLease = createWorkerLease(process.pid);
    if (!workerLease) {
      throw new Error(`Could not record start identity for task worker ${process.pid}.`);
    }
    cancellation = await createWorkerCancellationControl();
    await publishTaskWorkerHandshake(workerLease, cancellation.control);
    const storedJob = readStoredJob(workspaceRoot, jobId);
    if (!storedJob) {
      throw new Error(`No stored job found for ${jobId}.`);
    }
    if (!storedJob.request || typeof storedJob.request !== "object") {
      throw new Error(`Stored job ${jobId} is missing its task request payload.`);
    }

    updateState(workspaceRoot, (state) => {
      const index = state.jobs.findIndex(
        (job) =>
          job.id === jobId &&
          job.status === "queued" &&
          (!job.workerLease || workerLeasesMatch(job.workerLease, workerLease))
      );
      if (index === -1) {
        return;
      }
      const currentStoredJob = readStoredJob(workspaceRoot, jobId);
      if (
        !currentStoredJob ||
        currentStoredJob.status !== "queued" ||
        (currentStoredJob.workerLease && !workerLeasesMatch(currentStoredJob.workerLease, workerLease))
      ) {
        return;
      }
      claimedJob = {
        ...currentStoredJob,
        ...state.jobs[index],
        status: "running",
        startedAt: nowIso(),
        phase: "starting",
        pid: process.pid,
        workerLease,
        cancelControl: cancellation.control,
        launcherLease: null
      };
      writeJobFile(workspaceRoot, jobId, claimedJob);
      state.jobs[index] = claimedJob;
    });
    if (!claimedJob) {
      await cancellation.close();
      return;
    }
    tracking = createTrackedProgress(
      {
        ...claimedJob,
        workspaceRoot
      },
      {
        logFile: storedJob.logFile ?? null,
        preclaimedPid: process.pid,
        preclaimedLease: workerLease
      }
    );
  } catch (error) {
    await cancellation?.close();
    throw finalizeTaskWorkerFailure(workspaceRoot, jobId, error);
  }

  const request = claimedJob.request;
  const { logFile, progress } = tracking;
  try {
    await runTrackedJob(
      {
        ...claimedJob,
        workspaceRoot,
        logFile
      },
      () => {
        request.onProgress = progress;
        return executeTaskRun(request);
      },
      { logFile, preclaimedPid: process.pid, preclaimedLease: workerLease }
    );
  } catch (error) {
    throw finalizeTaskWorkerFailure(workspaceRoot, jobId, error);
  } finally {
    await cancellation?.close();
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const activeTasks = findActiveTaskJobs(jobs);
  if (activeTasks.length > 1) {
    throw new Error(AMBIGUOUS_ACTIVE_TASKS_ERROR);
  }
  const candidate = activeTasks[0] ?? findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId ?? null,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const reference = positionals[0] ?? "";
  const requestedAt = nowIso();
  let job = null;
  let existing = {};
  let pid = null;
  let workerLease = null;
  let cancelControl = null;
  let threadId = null;
  let turnId = null;
  updateState(workspaceRoot, (state) => {
    const activeJobs = sortJobsNewestFirst(state.jobs).filter(
      (candidate) => isActiveJobStatus(candidate.status)
    );
    if (reference) {
      job = activeJobs.find((candidate) => candidate.id === reference) ?? null;
      if (!job) {
        const matches = activeJobs.filter((candidate) => candidate.id.startsWith(reference));
        if (matches.length > 1) {
          throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
        }
        job = matches[0] ?? null;
      }
      if (!job) {
        throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
      }
    } else {
      const sessionId = getCurrentClaudeSessionId();
      const visibleJobs = sessionId ? activeJobs.filter((candidate) => candidate.sessionId === sessionId) : activeJobs;
      if (visibleJobs.length > 1) {
        throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
      }
      if (visibleJobs.length === 0) {
        throw new Error(sessionId ? "No active Codex jobs to cancel for this session." : "No active Codex jobs to cancel.");
      }
      job = visibleJobs[0];
    }

    try {
      existing = readStoredJob(workspaceRoot, job.id) ?? {};
    } catch {
      existing = {};
    }
    workerLease = job.workerLease ?? null;
    cancelControl = job.cancelControl ?? null;
    pid = workerLease?.pid ?? job.pid ?? null;
    threadId = job.threadId ?? existing.threadId ?? null;
    turnId = job.turnId ?? existing.turnId ?? null;
    const index = state.jobs.findIndex((candidate) => candidate.id === job.id);
    job = {
      ...job,
      status: "terminating",
      phase: "cancelling",
      pid,
      workerLease,
      cancelOriginStatus: job.cancelOriginStatus ?? job.status,
      cancellationRequestedAt: requestedAt,
      errorMessage: "Cancellation requested."
    };
    state.jobs[index] = { ...job, updatedAt: requestedAt };
  });

  try {
    writeJobFile(workspaceRoot, job.id, { ...existing, ...job });
  } catch {
    // The locked terminating index remains authoritative.
  }

  let interrupt = { attempted: false, interrupted: false, transport: null, detail: null };
  let terminationError = null;
  let liveness = job.cancelOriginStatus === "queued" && (!Number.isInteger(pid) || pid <= 0) ? "gone" : "unknown";
  try {
    interrupt = await interruptAppServerTurnBounded(cwd, { threadId, turnId });
    if (interrupt.attempted) {
      try {
        appendLogLine(
          job.logFile,
          interrupt.interrupted
            ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
            : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
        );
      } catch {
        // Process termination still runs from finally.
      }
    }
  } finally {
    const leaseLiveness = probeWorkerLease(workerLease);
    if (leaseLiveness === "gone" || leaseLiveness === "replaced") {
      liveness = "gone";
    } else if (leaseLiveness === "alive") {
      const cancellation = await requestWorkerCancellation(cancelControl);
      if (!cancellation.delivered) {
        terminationError = cancellation.detail;
      } else {
        const deadline = Date.now() + 1000;
        do {
          const currentLiveness = probeWorkerLease(workerLease);
          liveness = currentLiveness === "replaced" ? "gone" : currentLiveness;
          if (liveness === "gone" || Date.now() >= deadline) {
            break;
          }
          await sleep(25);
        } while (true);
      }
    } else if (Number.isInteger(pid) && pid > 0) {
      terminationError = `Could not verify worker identity for process ${pid}.`;
    }
  }

  if (liveness === "gone") {
    let threadArchived = null;
    let threadArchiveError = null;
    if (job.jobClass === "task" && threadId) {
      threadArchived = false;
      try {
        await archiveAppServerThread(cwd, threadId);
        threadArchived = true;
      } catch (error) {
        threadArchiveError = error instanceof Error ? error.message : String(error);
      }
    }

    const completedAt = nowIso();
    let cancelledJob = null;
    updateState(workspaceRoot, (state) => {
      const index = state.jobs.findIndex((candidate) => candidate.id === job.id);
      if (index === -1) {
        return;
      }
      const current = state.jobs[index];
      if (current.status === "cancelled") {
        cancelledJob = current;
        return;
      }
      if (
        current.status !== "terminating" ||
        current.pid !== pid ||
        (workerLease && !workerLeasesMatch(current.workerLease, workerLease))
      ) {
        return;
      }
      cancelledJob = {
        ...current,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        completedAt,
        cancelledAt: completedAt,
        errorMessage: "Cancelled by user.",
        ...(typeof threadArchived === "boolean" ? { threadArchived } : {}),
        ...(threadArchiveError ? { threadArchiveError } : {}),
        updatedAt: completedAt
      };
      state.jobs[index] = cancelledJob;
    });

    if (cancelledJob) {
      try {
        writeJobFile(workspaceRoot, job.id, { ...existing, ...cancelledJob });
      } catch {
        // The locked cancelled index remains authoritative.
      }
      appendLogLine(job.logFile, "Cancelled by user.");
      const payload = {
        jobId: job.id,
        status: "cancelled",
        title: job.title,
        turnInterruptAttempted: interrupt.attempted,
        turnInterrupted: interrupt.interrupted,
        ...(typeof cancelledJob.threadArchived === "boolean" ? { threadArchived: cancelledJob.threadArchived } : {}),
        ...(cancelledJob.threadArchiveError ? { threadArchiveError: cancelledJob.threadArchiveError } : {})
      };
      outputCommandResult(payload, renderCancelReport(cancelledJob), options.json);
      return;
    }
  }

  const cancellationError = terminationError
    ? `Cancellation could not confirm process ${pid} exited: ${terminationError}`
    : Number.isInteger(pid) && pid > 0
      ? `Cancellation timed out while waiting for process ${pid} to exit.`
      : "Cancellation could not confirm that the running worker exited because it has no process id.";
  let retainedJob = null;
  updateState(workspaceRoot, (state) => {
    const index = state.jobs.findIndex((candidate) => candidate.id === job.id);
    if (index === -1) {
      return;
    }
    const current = state.jobs[index];
    if (
      current.status !== "terminating" ||
      current.pid !== pid ||
      (workerLease && !workerLeasesMatch(current.workerLease, workerLease))
    ) {
      retainedJob = current;
      return;
    }
    retainedJob = {
      ...current,
      phase: "cancelling",
      errorMessage: cancellationError,
      updatedAt: nowIso()
    };
    state.jobs[index] = retainedJob;
  });
  if (retainedJob?.status === "cancelled") {
    const payload = {
      jobId: job.id,
      status: "cancelled",
      title: job.title,
      turnInterruptAttempted: interrupt.attempted,
      turnInterrupted: interrupt.interrupted,
      ...(typeof retainedJob.threadArchived === "boolean" ? { threadArchived: retainedJob.threadArchived } : {}),
      ...(retainedJob.threadArchiveError ? { threadArchiveError: retainedJob.threadArchiveError } : {})
    };
    outputCommandResult(payload, renderCancelReport(retainedJob), options.json);
    return;
  }
  if (retainedJob?.status === "terminating") {
    try {
      writeJobFile(workspaceRoot, job.id, { ...existing, ...retainedJob });
    } catch {
      // Retain the authoritative terminating index.
    }
    try {
      appendLogLine(job.logFile, cancellationError);
    } catch {
      // Keep the actionable state error when its log is unavailable.
    }
  }

  const payload = {
    jobId: job.id,
    status: retainedJob?.status ?? "terminating",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };
  outputCommandResult(
    payload,
    retainedJob?.status === "terminating"
      ? `Cancellation is still in progress for ${job.id}.\n${cancellationError}\n`
      : `Cancellation did not complete because ${job.id} is now ${retainedJob?.status ?? "missing"}.\n`,
    options.json
  );
  process.exitCode = 1;
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
