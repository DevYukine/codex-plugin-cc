import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, updateState, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

function leasesMatch(left, right) {
  return left?.pid === right?.pid && left?.startIdentity === right?.startIdentity;
}

function updateOwnedJob(workspaceRoot, jobId, ownerPid, ownerLease, mutate) {
  let updated = false;
  updateState(workspaceRoot, (state) => {
    const index = state.jobs.findIndex(
      (job) =>
        job.id === jobId &&
        job.status === "running" &&
        job.pid === ownerPid &&
        (!ownerLease || leasesMatch(job.workerLease, ownerLease))
    );
    if (index === -1) {
      return;
    }
    updated = mutate(state, index) !== false;
  });
  return updated;
}

export function createJobProgressUpdater(workspaceRoot, jobId, options = {}) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (options.preclaimedPid != null) {
      updateOwnedJob(workspaceRoot, jobId, options.preclaimedPid, options.preclaimedLease, (state, index) => {
        if (fs.existsSync(jobFile)) {
          const storedJob = readJobFile(jobFile);
          if (
            storedJob.status !== "running" ||
            storedJob.pid !== options.preclaimedPid ||
            (options.preclaimedLease && !leasesMatch(storedJob.workerLease, options.preclaimedLease))
          ) {
            return false;
          }
          writeJobFile(workspaceRoot, jobId, { ...storedJob, ...patch });
        }
        state.jobs[index] = { ...state.jobs[index], ...patch, updatedAt: nowIso() };
      });
      return;
    }

    upsertJob(workspaceRoot, patch);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function reconcileOwnedTerminalJob(workspaceRoot, jobId, ownerPid, ownerLease) {
  const terminal = readStoredJobOrNull(workspaceRoot, jobId);
  if (
    !terminal ||
    !["completed", "failed"].includes(terminal.status) ||
    terminal.ownerPid !== ownerPid ||
    (ownerLease && !leasesMatch(terminal.ownerLease, ownerLease))
  ) {
    return false;
  }
  return updateOwnedJob(workspaceRoot, jobId, ownerPid, ownerLease, (state, index) => {
    const current = state.jobs[index];
    state.jobs[index] = {
      ...current,
      status: terminal.status,
      threadId: terminal.threadId ?? null,
      turnId: terminal.turnId ?? null,
      summary: terminal.summary ?? current.summary,
      phase: terminal.phase,
      pid: null,
      completedAt: terminal.completedAt,
      ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
      updatedAt: terminal.completedAt
    };
  });
}

export async function runTrackedJob(job, runner, options = {}) {
  const preclaimedPid = options.preclaimedPid ?? null;
  const preclaimedLease = options.preclaimedLease ?? null;
  const ownerPid = preclaimedPid ?? process.pid;
  const ownerLease = preclaimedLease;
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  if (preclaimedPid != null) {
    const owned = updateOwnedJob(job.workspaceRoot, job.id, preclaimedPid, preclaimedLease, () => {
      const stored = readStoredJobOrNull(job.workspaceRoot, job.id);
      return (
        !stored ||
        (stored.status === "running" &&
          stored.pid === preclaimedPid &&
          (!preclaimedLease || leasesMatch(stored.workerLease, preclaimedLease)))
      );
    });
    if (!owned) {
      return null;
    }
  } else {
    writeJobFile(job.workspaceRoot, job.id, runningRecord);
    upsertJob(job.workspaceRoot, runningRecord);
  }

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    let finalized;
    try {
      finalized = updateOwnedJob(job.workspaceRoot, job.id, ownerPid, ownerLease, (state, index) => {
        const current = state.jobs[index];
        const stored = readStoredJobOrNull(job.workspaceRoot, job.id);
        if (
          stored &&
          (stored.status !== "running" ||
            stored.pid !== ownerPid ||
            (ownerLease && !leasesMatch(stored.workerLease, ownerLease)))
        ) {
          return false;
        }
        writeJobFile(job.workspaceRoot, job.id, {
          ...runningRecord,
          ...current,
          status: completionStatus,
          threadId: execution.threadId ?? null,
          turnId: execution.turnId ?? null,
          summary: execution.summary,
          pid: null,
          ownerPid,
          ...(ownerLease ? { ownerLease } : {}),
          phase: completionStatus === "completed" ? "done" : "failed",
          completedAt,
          result: execution.payload,
          rendered: execution.rendered
        });
        state.jobs[index] = {
          ...current,
          status: completionStatus,
          threadId: execution.threadId ?? null,
          turnId: execution.turnId ?? null,
          summary: execution.summary,
          phase: completionStatus === "completed" ? "done" : "failed",
          pid: null,
          completedAt,
          updatedAt: completedAt
        };
      });
    } catch (error) {
      if (reconcileOwnedTerminalJob(job.workspaceRoot, job.id, ownerPid, ownerLease)) {
        appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
        return execution;
      }
      throw error;
    }
    if (finalized) {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    }
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    try {
      updateOwnedJob(job.workspaceRoot, job.id, ownerPid, ownerLease, (state, index) => {
        const current = state.jobs[index];
        const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? current;
        if (
          existing.status !== "running" ||
          existing.pid !== ownerPid ||
          (ownerLease && !leasesMatch(existing.workerLease, ownerLease))
        ) {
          return false;
        }
        writeJobFile(job.workspaceRoot, job.id, {
          ...existing,
          ...(runningRecord.request ? { request: runningRecord.request } : {}),
          status: "failed",
          phase: "failed",
          errorMessage,
          pid: null,
          ownerPid,
          ...(ownerLease ? { ownerLease } : {}),
          completedAt,
          logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
        });
        state.jobs[index] = {
          ...current,
          status: "failed",
          phase: "failed",
          pid: null,
          errorMessage,
          completedAt,
          updatedAt: completedAt
        };
      });
    } catch (finalizationError) {
      if (!reconcileOwnedTerminalJob(job.workspaceRoot, job.id, ownerPid, ownerLease)) {
        throw finalizationError;
      }
    }
    throw error;
  }
}
