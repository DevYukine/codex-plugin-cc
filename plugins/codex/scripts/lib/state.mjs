import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_FILE_NAME = ".state.lock";
const LOCK_RECOVERY_FILE_NAME = ".state.lock.recovery";
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 10;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));
const PROCESS_START_IDENTITY = readProcessStartIdentity(process.pid);

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false,
      taskRoutes: {}
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  let contents;
  try {
    contents = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return defaultState();
    }
    throw error;
  }

  const parsed = JSON.parse(contents);
  const defaults = defaultState();
  return {
    ...defaults,
    ...parsed,
    config: {
      ...defaults.config,
      ...(parsed.config ?? {})
    },
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
  };
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function writeJsonAtomic(filePath, payload) {
  const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryFile, filePath);
  } finally {
    removeFileIfExists(temporaryFile);
  }
}

function readLinuxProcessStat(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
}

function readProcessStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }

  try {
    if (process.platform === "linux") {
      const fields = readLinuxProcessStat(pid);
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return fields[19] && bootId ? `linux:${bootId}:${fields[19]}` : undefined;
    }

    if (process.platform === "win32") {
      const startedAt = execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1_000, windowsHide: true }
      ).trim();
      return startedAt ? `win32:${startedAt}` : undefined;
    }

    const startedAt = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000
    }).trim();
    return startedAt ? `${process.platform}:${startedAt}` : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (process.platform === "linux") {
    try {
      if (readLinuxProcessStat(pid)[0] === "Z") {
        return false;
      }
    } catch {}
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function createLockOwner() {
  return JSON.stringify({ pid: process.pid, startIdentity: PROCESS_START_IDENTITY ?? null, token: randomUUID() });
}

function lockOwnerIsLive(owner) {
  let pid;
  let startIdentity;
  try {
    const parsed = JSON.parse(owner);
    pid = Number(parsed?.pid);
    startIdentity = typeof parsed?.startIdentity === "string" ? parsed.startIdentity : undefined;
  } catch {
    pid = Number(owner?.split(":", 1)[0]);
  }

  if (!processIsAlive(pid)) {
    return false;
  }
  if (!startIdentity) {
    return undefined;
  }
  const currentStartIdentity = readProcessStartIdentity(pid);
  return currentStartIdentity === undefined ? undefined : currentStartIdentity === startIdentity;
}

function readLockOwner(lockFile) {
  try {
    return fs.readFileSync(lockFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function claimLock(ownerFile, lockFile) {
  try {
    fs.linkSync(ownerFile, lockFile);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function lockIsOwnedBy(lockFile, ownerFile, owner) {
  try {
    const lockStats = fs.statSync(lockFile);
    const ownerStats = fs.statSync(ownerFile);
    return lockStats.dev === ownerStats.dev && lockStats.ino === ownerStats.ino && readLockOwner(lockFile) === owner;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function releaseLock(lockFile, ownerFile, owner) {
  if (!lockIsOwnedBy(lockFile, ownerFile, owner)) {
    return;
  }
  try {
    fs.unlinkSync(lockFile);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function findLockOwnerFile(lockFile, lockStats) {
  const directory = path.dirname(lockFile);
  const prefix = `${path.basename(lockFile)}.owner-`;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const ownerFile = path.join(directory, entry);
    try {
      const ownerStats = fs.statSync(ownerFile);
      if (lockStats.dev === ownerStats.dev && lockStats.ino === ownerStats.ino) {
        return ownerFile;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return undefined;
}

function reapStaleOwnerFiles(lockFile) {
  const directory = path.dirname(lockFile);
  const prefix = `${path.basename(lockFile)}.owner-`;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.startsWith(prefix)) {
      continue;
    }

    const ownerFile = path.join(directory, entry);
    let ownerStats;
    try {
      ownerStats = fs.statSync(ownerFile);
      if (
        ownerStats.nlink !== 1 ||
        Date.now() - ownerStats.mtimeMs < LOCK_STALE_MS ||
        lockOwnerIsLive(readLockOwner(ownerFile)) !== false
      ) {
        continue;
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const reapingOwnerFile = `${lockFile}.owner-reaping-${process.pid}-${randomUUID()}`;
    try {
      fs.renameSync(ownerFile, reapingOwnerFile);
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    try {
      if (fs.statSync(reapingOwnerFile).nlink === 1) {
        fs.unlinkSync(reapingOwnerFile);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function recoveringOwnerIsLive(ownerFile, recoveringPrefix) {
  const suffix = ownerFile.slice(recoveringPrefix.length);
  if (/^\d+-/.test(suffix)) {
    return processIsAlive(Number(suffix.split("-", 1)[0]));
  }
  return lockOwnerIsLive(Buffer.from(suffix, "base64url").toString("utf8"));
}

function recoverLockFile(lockFile) {
  let lockStats;
  try {
    lockStats = fs.statSync(lockFile);
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }
    throw error;
  }

  const owner = readLockOwner(lockFile);
  const ownerIsLive = lockOwnerIsLive(owner);
  if (ownerIsLive === true || (ownerIsLive === undefined && Date.now() - lockStats.mtimeMs < LOCK_STALE_MS)) {
    return false;
  }

  const ownerFile = findLockOwnerFile(lockFile, lockStats);
  if (!ownerFile) {
    return false;
  }

  const recoveringPrefix = `${lockFile}.owner-recovering-`;
  if (ownerFile.startsWith(recoveringPrefix)) {
    const recoveringOwnerIsLiveStatus = recoveringOwnerIsLive(ownerFile, recoveringPrefix);
    if (
      recoveringOwnerIsLiveStatus === true ||
      (recoveringOwnerIsLiveStatus === undefined && Date.now() - lockStats.mtimeMs < LOCK_STALE_MS)
    ) {
      return false;
    }
  }

  const recoveringOwner = createLockOwner();
  const recoveringOwnerFile = `${recoveringPrefix}${Buffer.from(recoveringOwner).toString("base64url")}`;
  try {
    fs.renameSync(ownerFile, recoveringOwnerFile);
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  try {
    if (!lockIsOwnedBy(lockFile, recoveringOwnerFile, owner)) {
      return false;
    }
    fs.unlinkSync(lockFile);
    return true;
  } finally {
    removeFileIfExists(recoveringOwnerFile);
  }
}

function recoverStaleLock(lockFile, recoveryLockFile, ownerFile, startedAt) {
  const recoveryOwner = createLockOwner();
  const recoveryOwnerFile = `${recoveryLockFile}.owner-${randomUUID()}`;
  fs.writeFileSync(recoveryOwnerFile, recoveryOwner, { encoding: "utf8", flag: "wx" });

  try {
    if (!claimLock(recoveryOwnerFile, recoveryLockFile)) {
      if (!recoverLockFile(recoveryLockFile) || !claimLock(recoveryOwnerFile, recoveryLockFile)) {
        return false;
      }
    }

    try {
      if (!recoverLockFile(lockFile)) {
        return false;
      }

      while (!claimLock(ownerFile, lockFile)) {
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for state lock: ${lockFile}`);
        }
        Atomics.wait(lockWaitArray, 0, 0, LOCK_RETRY_MS);
      }
      return true;
    } finally {
      releaseLock(recoveryLockFile, recoveryOwnerFile, recoveryOwner);
    }
  } finally {
    removeFileIfExists(recoveryOwnerFile);
  }
}

function withStateLock(cwd, callback) {
  ensureStateDir(cwd);
  const stateDir = resolveStateDir(cwd);
  const lockFile = path.join(stateDir, LOCK_FILE_NAME);
  const recoveryLockFile = path.join(stateDir, LOCK_RECOVERY_FILE_NAME);
  reapStaleOwnerFiles(lockFile);
  reapStaleOwnerFiles(recoveryLockFile);
  const owner = createLockOwner();
  const ownerFile = `${lockFile}.owner-${randomUUID()}`;
  const startedAt = Date.now();
  fs.writeFileSync(ownerFile, owner, { encoding: "utf8", flag: "wx" });

  try {
    for (;;) {
      let acquired = false;
      if (fs.existsSync(recoveryLockFile)) {
        recoverLockFile(recoveryLockFile);
      } else {
        acquired = claimLock(ownerFile, lockFile);
        if (!acquired) {
          acquired = recoverStaleLock(lockFile, recoveryLockFile, ownerFile, startedAt);
        }
      }

      if (acquired) {
        if (fs.existsSync(recoveryLockFile)) {
          releaseLock(lockFile, ownerFile, owner);
        } else if (lockIsOwnedBy(lockFile, ownerFile, owner)) {
          try {
            return callback();
          } finally {
            releaseLock(lockFile, ownerFile, owner);
          }
        }
      }

      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for state lock: ${lockFile}`);
      }
      Atomics.wait(lockWaitArray, 0, 0, LOCK_RETRY_MS);
    }
  } finally {
    removeFileIfExists(ownerFile);
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  writeJsonAtomic(resolveStateFile(cwd), nextState);

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeJsonAtomic(jobFile, payload);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
