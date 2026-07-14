#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { probeProcess, terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { resolveStateFile, updateState } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

if (process.platform !== "win32") {
  process.umask(0o077);
}

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running" || status === "terminating";
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

async function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const selectedJobs = [];
  updateState(workspaceRoot, (state) => {
    state.jobs = state.jobs.map((job) => {
      if (job.sessionId !== sessionId || job.jobClass === "task" || job.kind === "task") {
        return job;
      }
      selectedJobs.push(job);
      if (!isActiveJobStatus(job.status) || probeWorkerLease(job.workerLease) !== "alive") {
        return job;
      }
      return { ...job, status: "terminating", phase: "terminating" };
    });
  });
  if (selectedJobs.length === 0) {
    return;
  }

  const signaledLeases = [];
  for (const job of selectedJobs) {
    if (!isActiveJobStatus(job.status) || probeWorkerLease(job.workerLease) !== "alive") {
      continue;
    }
    signaledLeases.push(job.workerLease);
    try {
      terminateProcessTree(job.workerLease.pid);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  const deadline = Date.now() + 1000;
  while (signaledLeases.length > 0 && Date.now() < deadline) {
    const anyAlive = signaledLeases.some((lease) => {
      const liveness = probeWorkerLease(lease);
      return liveness !== "gone" && liveness !== "replaced";
    });
    if (!anyAlive) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const removableIds = new Set();
  for (const job of selectedJobs) {
    const active = isActiveJobStatus(job.status);
    if (!active || (job.status === "queued" && (!Number.isInteger(job.pid) || job.pid <= 0))) {
      removableIds.add(job.id);
    } else if (["gone", "replaced"].includes(probeWorkerLease(job.workerLease))) {
      removableIds.add(job.id);
    }
  }
  updateState(workspaceRoot, (state) => {
    state.jobs = state.jobs.filter((job) => !removableIds.has(job.id));
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  await cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
