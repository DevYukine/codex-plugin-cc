import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  buildStatusSnapshot,
  resolveCancelableJob,
  resolveResultJob
} from "../plugins/codex/scripts/lib/job-control.mjs";
import { renderJobStatusReport } from "../plugins/codex/scripts/lib/render.mjs";
import { loadState, resolveStateDir, saveState } from "../plugins/codex/scripts/lib/state.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");
const STOP_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "stop-review-gate-hook.mjs");

function readWorkerLease(pid) {
  if (process.platform === "linux") {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trimStart().split(/\s+/);
    return { pid, startIdentity: `linux:${fields[19]}` };
  }
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
          ],
          { encoding: "utf8", windowsHide: true }
        )
      : spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C" }
        });
  assert.equal(result.status, 0, result.stderr);
  return { pid, startIdentity: `${process.platform}:${result.stdout.trim().replace(/\s+/g, " ")}` };
}

function installStopHookSpawnMock(workspace) {
  const preload = path.join(workspace, "stop-hook-spawn-mock.cjs");
  const callsFile = path.join(workspace, "stop-hook-spawn-calls.jsonl");
  fs.writeFileSync(
    preload,
    `const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const originalSpawnSync = childProcess.spawnSync;
function updateJob(status) {
  const stateFile = process.env.STOP_HOOK_STATE_FILE;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const index = state.jobs.findIndex((job) => job.id === JSON.parse(process.env.STOP_HOOK_JOB).id);
  const job = {
    ...state.jobs[index],
    status,
    phase: status === "terminating" ? "cancelling" : status,
    pid: null,
    updatedAt: new Date().toISOString()
  };
  state.jobs[index] = job;
  fs.writeFileSync(stateFile, JSON.stringify(state) + "\\n", "utf8");
  fs.writeFileSync(process.env.STOP_HOOK_JOB_FILE, JSON.stringify(job) + "\\n", "utf8");
  return job;
}
childProcess.spawnSync = function (command, args = [], options = {}) {
  if (
    command === process.execPath &&
    args[0] === "--input-type=module" &&
    String(args[2] ?? "").includes("getCodexAvailability") &&
    process.env.STOP_HOOK_AVAILABILITY_RESULT === "timeout"
  ) {
    fs.appendFileSync(process.env.STOP_HOOK_CALLS_FILE, JSON.stringify({ args: ["availability"], timeout: options.timeout }) + "\\n");
    const error = new Error("timed out");
    error.code = "ETIMEDOUT";
    return { status: null, signal: "SIGTERM", stdout: "", stderr: "", error };
  }
  if (command === "codex") {
    return { status: 0, signal: null, stdout: "codex-test\\n", stderr: "", error: null };
  }
  if (path.basename(String(args[0] ?? "")) !== "codex-companion.mjs") {
    return originalSpawnSync.apply(this, arguments);
  }
  fs.appendFileSync(process.env.STOP_HOOK_CALLS_FILE, JSON.stringify({ args, timeout: options.timeout }) + "\\n");
  if (args[1] === "cancel" && process.env.STOP_HOOK_CANCEL_RESULT === "terminating") {
    const job = updateJob("terminating");
    return { status: 1, signal: null, stdout: JSON.stringify({ jobId: job.id, status: job.status }), stderr: "", error: null };
  }
  if (args[1] === "cancel" && process.env.STOP_HOOK_CANCEL_RESULT === "failed") {
    return { status: 1, signal: null, stdout: "", stderr: "cancel failed", error: null };
  }
  if (args[1] === "status" && process.env.STOP_HOOK_STATUS_RESULT) {
    const job = updateJob(process.env.STOP_HOOK_STATUS_RESULT);
    return { status: 0, signal: null, stdout: JSON.stringify({ job, waitTimedOut: job.status === "running" }), stderr: "", error: null };
  }
  if (args[1] !== "task") {
    return originalSpawnSync.apply(this, arguments);
  }
  if (["timeout", "outer-timeout"].includes(process.env.STOP_HOOK_TASK_RESULT)) {
    const job = JSON.parse(process.env.STOP_HOOK_JOB);
    const stateFile = process.env.STOP_HOOK_STATE_FILE;
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.jobs.unshift(job);
    fs.mkdirSync(path.dirname(process.env.STOP_HOOK_JOB_FILE), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state) + "\\n", "utf8");
    fs.writeFileSync(process.env.STOP_HOOK_JOB_FILE, JSON.stringify(job) + "\\n", "utf8");
    fs.writeFileSync(job.logFile, "queued\\n", "utf8");
    if (process.env.STOP_HOOK_TASK_RESULT === "outer-timeout") {
      const error = new Error("timed out");
      error.code = "ETIMEDOUT";
      return { status: null, signal: "SIGTERM", stdout: "", stderr: "", error };
    }
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify({ jobId: job.id, status: job.status, waitTimedOut: true, timeoutMs: 780000 }),
      stderr: "",
      error: null
    };
  }
  return {
    status: 0,
    signal: null,
    stdout: JSON.stringify({ rawOutput: "ALLOW: clean" }),
    stderr: "",
    error: null
  };
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );
  return { preload, callsFile };
}

function readStopHookCalls(callsFile) {
  return fs.existsSync(callsFile)
    ? fs
        .readFileSync(callsFile, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function makeTimedOutStopReview(workspace, id, status = "queued") {
  saveState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
  const stateDir = resolveStateDir(workspace);
  const job = {
    id,
    kind: "task",
    jobClass: "task",
    status,
    phase: status,
    title: "Codex Stop Gate Review",
    summary: "Stop-gate review of previous Claude turn",
    sessionId: "sess-current",
    pid: null,
    logFile: path.join(stateDir, "jobs", `${id}.log`),
    request: { prompt: "Run a stop-gate review of the previous Claude turn." },
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z"
  };
  return { job, stateDir, jobFile: path.join(stateDir, "jobs", `${id}.json`) };
}

test("stop review gate passes an explicit bounded task timeout", () => {
  const workspace = makeTempDir();
  saveState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
  const { preload, callsFile } = installStopHookSpawnMock(workspace);
  const result = run(process.execPath, [STOP_HOOK], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim(),
      STOP_HOOK_CALLS_FILE: callsFile
    },
    input: JSON.stringify({ cwd: workspace, session_id: "sess-current" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const taskCall = readStopHookCalls(callsFile).find((call) => call.args[1] === "task");
  const timeoutIndex = taskCall.args.indexOf("--timeout-ms");
  const attachTimeout = Number(taskCall.args[timeoutIndex + 1]);
  assert.ok(timeoutIndex > 0);
  assert.ok(attachTimeout > 0 && attachTimeout < 15 * 60 * 1000);
  assert.ok(taskCall.timeout > attachTimeout && taskCall.timeout < 15 * 60 * 1000);
});

test("stop review gate bounds availability and degrades when it times out", () => {
  const workspace = makeTempDir();
  saveState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
  const { preload, callsFile } = installStopHookSpawnMock(workspace);
  const result = run(process.execPath, [STOP_HOOK], {
    cwd: workspace,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim(),
      STOP_HOOK_CALLS_FILE: callsFile,
      STOP_HOOK_AVAILABILITY_RESULT: "timeout"
    },
    input: JSON.stringify({ cwd: workspace })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex is not set up for the review gate/i);
  assert.match(result.stderr, /availability check timed out/i);
  const calls = readStopHookCalls(callsFile);
  const availabilityCall = calls.find((call) => call.args[0] === "availability");
  assert.ok(availabilityCall.timeout > 0 && availabilityCall.timeout <= 5 * 1000);
  assert.equal(calls.some((call) => call.args[1] === "task"), false);
});

test("stop review gate cancels and records cleanup after an attach timeout", () => {
  const workspace = makeTempDir();
  const { job, stateDir, jobFile } = makeTimedOutStopReview(workspace, "task-stop-timeout");
  const { preload, callsFile } = installStopHookSpawnMock(workspace);
  const result = run(process.execPath, [STOP_HOOK], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim(),
      STOP_HOOK_CALLS_FILE: callsFile,
      STOP_HOOK_TASK_RESULT: "timeout",
      STOP_HOOK_STATE_FILE: path.join(stateDir, "state.json"),
      STOP_HOOK_JOB_FILE: jobFile,
      STOP_HOOK_JOB: JSON.stringify(job)
    },
    input: JSON.stringify({ cwd: workspace, session_id: "sess-current" })
  });

  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /timed out/i);
  assert.match(decision.reason, /completed with status cancelled/i);
  const cancelled = loadState(workspace).jobs.find((candidate) => candidate.id === job.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "cancelled");
  assert.deepEqual(
    readStopHookCalls(callsFile).map((call) => call.args[1]),
    ["task", "cancel"]
  );
});

test("stop review gate confirms cleanup when cancellation remains active", () => {
  const workspace = makeTempDir();
  const { job, stateDir, jobFile } = makeTimedOutStopReview(workspace, "task-stop-confirm", "running");
  const { preload, callsFile } = installStopHookSpawnMock(workspace);
  const result = run(process.execPath, [STOP_HOOK], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim(),
      STOP_HOOK_CALLS_FILE: callsFile,
      STOP_HOOK_TASK_RESULT: "timeout",
      STOP_HOOK_CANCEL_RESULT: "terminating",
      STOP_HOOK_STATUS_RESULT: "cancelled",
      STOP_HOOK_STATE_FILE: path.join(stateDir, "state.json"),
      STOP_HOOK_JOB_FILE: jobFile,
      STOP_HOOK_JOB: JSON.stringify(job)
    },
    input: JSON.stringify({ cwd: workspace, session_id: "sess-current" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, /completed with status cancelled/i);
  assert.equal(loadState(workspace).jobs.find((candidate) => candidate.id === job.id).status, "cancelled");
  assert.deepEqual(
    readStopHookCalls(callsFile).map((call) => call.args[1]),
    ["task", "cancel", "status"]
  );
});

test("stop review gate reports unconfirmed cleanup when cancellation fails", () => {
  const workspace = makeTempDir();
  const { job, stateDir, jobFile } = makeTimedOutStopReview(workspace, "task-stop-cancel-failed", "running");
  const { preload, callsFile } = installStopHookSpawnMock(workspace);
  const result = run(process.execPath, [STOP_HOOK], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim(),
      STOP_HOOK_CALLS_FILE: callsFile,
      STOP_HOOK_TASK_RESULT: "timeout",
      STOP_HOOK_CANCEL_RESULT: "failed",
      STOP_HOOK_STATUS_RESULT: "running",
      STOP_HOOK_STATE_FILE: path.join(stateDir, "state.json"),
      STOP_HOOK_JOB_FILE: jobFile,
      STOP_HOOK_JOB: JSON.stringify(job)
    },
    input: JSON.stringify({ cwd: workspace, session_id: "sess-current" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, /could not be confirmed because it remains running/i);
  assert.equal(loadState(workspace).jobs.find((candidate) => candidate.id === job.id).status, "running");
  assert.deepEqual(
    readStopHookCalls(callsFile).map((call) => call.args[1]),
    ["task", "cancel", "status"]
  );
});

test("stop review gate cleans up a task command that exceeds its outer timeout", () => {
  const workspace = makeTempDir();
  const { job, stateDir, jobFile } = makeTimedOutStopReview(workspace, "task-stop-outer-timeout");
  const { preload, callsFile } = installStopHookSpawnMock(workspace);
  const result = run(process.execPath, [STOP_HOOK], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim(),
      STOP_HOOK_CALLS_FILE: callsFile,
      STOP_HOOK_TASK_RESULT: "outer-timeout",
      STOP_HOOK_STATE_FILE: path.join(stateDir, "state.json"),
      STOP_HOOK_JOB_FILE: jobFile,
      STOP_HOOK_JOB: JSON.stringify(job)
    },
    input: JSON.stringify({ cwd: workspace, session_id: "sess-current" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, /completed with status cancelled/i);
  assert.equal(loadState(workspace).jobs.find((candidate) => candidate.id === job.id).status, "cancelled");
  assert.deepEqual(
    readStopHookCalls(callsFile).map((call) => call.args[1]),
    ["task", "cancel"]
  );
});

test("stop review gate does not enqueue a duplicate while cleanup is active", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: true },
    jobs: [
      {
        id: "task-stop-cleanup",
        kind: "task",
        jobClass: "task",
        status: "terminating",
        phase: "cancelling",
        title: "Codex Stop Gate Review",
        sessionId: "sess-current",
        request: { prompt: "Run a stop-gate review of the previous Claude turn." },
        createdAt: "2026-07-14T12:00:00.000Z",
        updatedAt: "2026-07-14T12:01:00.000Z"
      }
    ]
  });
  const { preload, callsFile } = installStopHookSpawnMock(workspace);
  const result = run(process.execPath, [STOP_HOOK], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim(),
      STOP_HOOK_CALLS_FILE: callsFile
    },
    input: JSON.stringify({ cwd: workspace, session_id: "sess-current" })
  });

  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /duplicate review was not started/i);
  assert.deepEqual(readStopHookCalls(callsFile), []);
  assert.deepEqual(loadState(workspace).jobs.map((job) => job.id), ["task-stop-cleanup"]);
});

test("terminating jobs remain active in status, result, rendering, and the stop gate", () => {
  const workspace = makeTempDir();
  const createdAt = "2026-07-14T12:00:00.000Z";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-terminating",
        kind: "task",
        jobClass: "task",
        status: "terminating",
        sessionId: "sess-current",
        write: true,
        createdAt,
        updatedAt: "2026-07-14T12:02:00.000Z"
      },
      {
        id: "task-completed",
        kind: "task",
        jobClass: "task",
        status: "completed",
        sessionId: "sess-current",
        createdAt,
        completedAt: "2026-07-14T12:01:00.000Z",
        updatedAt: "2026-07-14T12:01:00.000Z"
      }
    ]
  });

  const snapshot = buildStatusSnapshot(workspace, {
    env: { CODEX_COMPANION_SESSION_ID: "sess-current" }
  });
  assert.deepEqual(snapshot.running.map((job) => job.id), ["task-terminating"]);
  assert.equal(snapshot.running[0].phase, "cancelling");
  assert.equal(snapshot.latestFinished.id, "task-completed");
  assert.throws(() => resolveResultJob(workspace, "task-terminating"), /still terminating/);
  assert.equal(resolveResultJob(workspace).job.id, "task-completed");
  assert.equal(resolveCancelableJob(workspace, "task-terminating").job.id, "task-terminating");

  const rendered = renderJobStatusReport(snapshot.running[0]);
  assert.match(rendered, /Cancel: \/codex:cancel task-terminating/);
  assert.doesNotMatch(rendered, /Result:|Review changes:|Duration:/);

  const stopped = run(process.execPath, [STOP_HOOK], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({ cwd: workspace, session_id: "sess-current" })
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stderr, /task-terminating is still running/);
});

test("session cleanup does not signal PIDs with replaced or missing leases", (t) => {
  const workspace = makeTempDir();
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid);
    } catch {
      // The process already exited.
    }
  });

  const workerLease = readWorkerLease(sleeper.pid);
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "review-stale",
        kind: "review",
        jobClass: "review",
        status: "running",
        sessionId: "sess-current",
        pid: sleeper.pid,
        workerLease: { ...workerLease, startIdentity: `${workerLease.startIdentity}:stale` },
        createdAt: "2026-07-14T12:00:00.000Z",
        updatedAt: "2026-07-14T12:01:00.000Z"
      },
      {
        id: "review-unverified",
        kind: "review",
        jobClass: "review",
        status: "running",
        sessionId: "sess-current",
        pid: sleeper.pid,
        createdAt: "2026-07-14T12:00:00.000Z",
        updatedAt: "2026-07-14T12:00:30.000Z"
      }
    ]
  });

  const result = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-current", cwd: workspace })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  const remaining = loadState(workspace).jobs;
  assert.deepEqual(remaining.map((job) => job.id), ["review-unverified"]);
  assert.equal(remaining[0].status, "running");
});
