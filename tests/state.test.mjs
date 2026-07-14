import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { makeTempDir } from "./helpers.mjs";
import {
  getConfig,
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  setConfig,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

const execFileAsync = promisify(execFile);

test("task route overrides default to an empty object and persist", () => {
  const workspace = makeTempDir();

  assert.deepEqual(getConfig(workspace).taskRoutes, {});
  setConfig(workspace, "taskRoutes", { custom: { model: "gpt-5.6-terra" } });
  assert.deepEqual(getConfig(workspace).taskRoutes, { custom: { model: "gpt-5.6-terra" } });
});

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("concurrent upserts preserve every job", async () => {
  const workspace = makeTempDir();
  const jobIds = Array.from({ length: 12 }, (_, index) => `concurrent-${index}`);
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const script = `import { upsertJob } from ${JSON.stringify(stateModule)}; upsertJob(process.env.TEST_WORKSPACE, { id: process.env.TEST_JOB_ID, status: "queued" });`;

  await Promise.all(
    jobIds.map((jobId) =>
      execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, TEST_WORKSPACE: workspace, TEST_JOB_ID: jobId }
      })
    )
  );

  assert.deepEqual(
    listJobs(workspace)
      .map((job) => job.id)
      .sort(),
    jobIds.sort()
  );
});

test("state and job JSON replacements remain valid through rename", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const jobFile = writeJobFile(workspace, "atomic", { id: "atomic", status: "queued" });
  saveState(workspace, { jobs: [] });
  const destinations = new Set();
  const originalRenameSync = fs.renameSync;

  fs.renameSync = (source, destination) => {
    if (destination === stateFile || destination === jobFile) {
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(destination, "utf8")));
    }
    const result = originalRenameSync(source, destination);
    if (destination === stateFile || destination === jobFile) {
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(destination, "utf8")));
      destinations.add(destination);
    }
    return result;
  };

  try {
    saveState(workspace, { config: { stopReviewGate: true }, jobs: [] });
    writeJobFile(workspace, "atomic", { id: "atomic", status: "completed" });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.deepEqual([...destinations].sort(), [jobFile, stateFile].sort());
});

test("a fresh lock from an exited process is recovered without waiting", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), ".state.lock");
  const ownerFile = `${lockFile}.owner-abandoned`;
  const originalWait = Atomics.wait;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(ownerFile, "2147483647:abandoned", "utf8");
  fs.linkSync(ownerFile, lockFile);

  Atomics.wait = () => assert.fail("dead lock owner should be recovered immediately");
  try {
    upsertJob(workspace, { id: "recovered", status: "queued" });
  } finally {
    Atomics.wait = originalWait;
  }

  assert.equal(fs.existsSync(lockFile), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(lockFile)).filter((entry) => entry.startsWith(".state.lock.owner-")),
    []
  );
  assert.equal(listJobs(workspace)[0].id, "recovered");
});

test("a Linux zombie lock owner is recovered without waiting", { skip: process.platform !== "linux" }, () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), ".state.lock");
  const ownerFile = `${lockFile}.owner-zombie`;
  const originalReadFileSync = fs.readFileSync;
  const originalWait = Atomics.wait;
  const startTime = "12345";
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const zombieStat = `${process.pid} (zombie) ${["Z", ...Array(18).fill("0"), startTime].join(" ")}`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    ownerFile,
    JSON.stringify({ pid: process.pid, startIdentity: `linux:${bootId}:${startTime}`, token: "zombie" }),
    "utf8"
  );
  fs.linkSync(ownerFile, lockFile);

  fs.readFileSync = (file, ...args) =>
    file === `/proc/${process.pid}/stat` ? zombieStat : originalReadFileSync(file, ...args);
  Atomics.wait = () => assert.fail("a zombie lock owner should be recovered immediately");
  try {
    upsertJob(workspace, { id: "zombie-recovered", status: "queued" });
  } finally {
    fs.readFileSync = originalReadFileSync;
    Atomics.wait = originalWait;
  }

  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(listJobs(workspace)[0].id, "zombie-recovered");
});

test("a stale lock whose PID was reused is recovered", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), ".state.lock");
  const ownerFile = `${lockFile}.owner-reused-pid`;
  const originalWait = Atomics.wait;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    ownerFile,
    JSON.stringify({ pid: process.pid, startIdentity: "previous-process", token: "abandoned" }),
    "utf8"
  );
  fs.linkSync(ownerFile, lockFile);
  const staleTime = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lockFile, staleTime, staleTime);

  Atomics.wait = () => assert.fail("a reused PID should not keep a stale lock alive");
  try {
    upsertJob(workspace, { id: "reused-pid-recovered", status: "queued" });
  } finally {
    Atomics.wait = originalWait;
  }

  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(listJobs(workspace)[0].id, "reused-pid-recovered");
});

test("stale unlinked owner files are reaped before acquisition", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const ownerFiles = [
    path.join(stateDir, ".state.lock.owner-abandoned"),
    path.join(stateDir, ".state.lock.recovery.owner-abandoned")
  ];
  fs.mkdirSync(stateDir, { recursive: true });
  const staleTime = new Date(Date.now() - 60 * 60 * 1000);
  for (const ownerFile of ownerFiles) {
    fs.writeFileSync(ownerFile, "2147483647:abandoned", "utf8");
    fs.utimesSync(ownerFile, staleTime, staleTime);
  }

  upsertJob(workspace, { id: "owners-reaped", status: "queued" });

  assert.deepEqual(ownerFiles.map((ownerFile) => fs.existsSync(ownerFile)), [false, false]);
  assert.equal(listJobs(workspace)[0].id, "owners-reaped");
});

test("a stale live owner candidate is not reaped", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), ".state.lock");
  const liveOwnerFile = `${lockFile}.owner-live`;
  const originalLinkSync = fs.linkSync;
  let copied = false;

  fs.linkSync = (existingPath, newPath) => {
    if (!copied && newPath === lockFile) {
      fs.copyFileSync(existingPath, liveOwnerFile);
      const staleTime = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(liveOwnerFile, staleTime, staleTime);
      copied = true;
    }
    return originalLinkSync(existingPath, newPath);
  };

  try {
    upsertJob(workspace, { id: "live-owner-created", status: "queued" });
  } finally {
    fs.linkSync = originalLinkSync;
  }

  try {
    upsertJob(workspace, { id: "live-owner-preserved", status: "queued" });
    assert.equal(fs.existsSync(liveOwnerFile), true);
    assert.equal(typeof JSON.parse(fs.readFileSync(liveOwnerFile, "utf8")).startIdentity, "string");
  } finally {
    fs.rmSync(liveOwnerFile, { force: true });
  }

  assert.equal(copied, true);
  assert.equal(listJobs(workspace)[0].id, "live-owner-preserved");
});

test("owner reaping preserves a candidate linked during cleanup", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), ".state.lock");
  const ownerFile = `${lockFile}.owner-racing`;
  const originalLinkSync = fs.linkSync;
  const originalRenameSync = fs.renameSync;
  const originalUnlinkSync = fs.unlinkSync;
  let reapingOwnerFile;
  let linkedOwnerUnlinked = false;

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(ownerFile, "2147483647:abandoned", "utf8");
  const staleTime = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(ownerFile, staleTime, staleTime);

  fs.renameSync = (source, destination) => {
    if (source === ownerFile) {
      originalLinkSync(ownerFile, lockFile);
      reapingOwnerFile = destination;
    }
    return originalRenameSync(source, destination);
  };
  fs.unlinkSync = (file) => {
    if (file === reapingOwnerFile && fs.existsSync(lockFile)) {
      linkedOwnerUnlinked = true;
    }
    return originalUnlinkSync(file);
  };

  try {
    upsertJob(workspace, { id: "reaping-race-safe", status: "queued" });
  } finally {
    fs.renameSync = originalRenameSync;
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(reapingOwnerFile != null, true);
  assert.equal(linkedOwnerUnlinked, false);
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(listJobs(workspace)[0].id, "reaping-race-safe");
});

test("an abandoned stale recovery lock is recovered", () => {
  const workspace = makeTempDir();
  const recoveryLockFile = path.join(resolveStateDir(workspace), ".state.lock.recovery");
  const recoveryOwnerFile = `${recoveryLockFile}.owner-abandoned`;
  fs.mkdirSync(path.dirname(recoveryLockFile), { recursive: true });
  fs.writeFileSync(recoveryOwnerFile, "2147483647:abandoned", "utf8");
  fs.linkSync(recoveryOwnerFile, recoveryLockFile);
  const staleTime = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(recoveryLockFile, staleTime, staleTime);

  upsertJob(workspace, { id: "recovery-recovered", status: "queued" });

  assert.equal(fs.existsSync(recoveryLockFile), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(recoveryLockFile)).filter((entry) =>
      entry.startsWith(".state.lock.recovery.owner-")
    ),
    []
  );
  assert.equal(listJobs(workspace)[0].id, "recovery-recovered");
});

test("a lock creator cannot overwrite or release a replacement owner", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), ".state.lock");
  const replacementOwnerFile = `${lockFile}.owner-replacement`;
  const replacementOwner = `${process.pid}:replacement`;
  const originalLinkSync = fs.linkSync;
  const originalWait = Atomics.wait;
  let replaced = false;
  let replacementObserved = false;

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(replacementOwnerFile, replacementOwner, "utf8");
  fs.linkSync = (existingPath, newPath) => {
    if (!replaced && newPath === lockFile) {
      replaced = true;
      originalLinkSync(replacementOwnerFile, lockFile);
    }
    return originalLinkSync(existingPath, newPath);
  };
  Atomics.wait = () => {
    replacementObserved = fs.readFileSync(lockFile, "utf8") === replacementOwner;
    fs.unlinkSync(lockFile);
    return "ok";
  };

  try {
    upsertJob(workspace, { id: "replacement-safe", status: "queued" });
  } finally {
    fs.linkSync = originalLinkSync;
    Atomics.wait = originalWait;
    fs.rmSync(replacementOwnerFile, { force: true });
  }

  assert.equal(replaced, true);
  assert.equal(replacementObserved, true);
  assert.equal(listJobs(workspace)[0].id, "replacement-safe");
});

test("stale recovery makes a racing acquisition retry", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), ".state.lock");
  const recoveryLockFile = path.join(resolveStateDir(workspace), ".state.lock.recovery");
  const oldOwnerFile = `${lockFile}.owner-old`;
  const racerOwnerFile = `${lockFile}.owner-racer`;
  const racerOwner = `${process.pid}:racer`;
  const originalUnlinkSync = fs.unlinkSync;
  const originalWait = Atomics.wait;
  let raced = false;
  let racerProtected = false;

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(oldOwnerFile, "2147483647:old", "utf8");
  fs.linkSync(oldOwnerFile, lockFile);
  fs.writeFileSync(racerOwnerFile, racerOwner, "utf8");
  const staleTime = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lockFile, staleTime, staleTime);

  fs.unlinkSync = (file) => {
    if (!raced && file === lockFile) {
      originalUnlinkSync(lockFile);
      fs.linkSync(racerOwnerFile, lockFile);
      raced = true;
      return;
    }
    return originalUnlinkSync(file);
  };
  Atomics.wait = () => {
    racerProtected = fs.existsSync(recoveryLockFile) && fs.readFileSync(lockFile, "utf8") === racerOwner;
    originalUnlinkSync(lockFile);
    return "ok";
  };

  try {
    upsertJob(workspace, { id: "recovery-race-safe", status: "queued" });
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    Atomics.wait = originalWait;
    fs.rmSync(oldOwnerFile, { force: true });
    fs.rmSync(racerOwnerFile, { force: true });
  }

  assert.equal(raced, true);
  assert.equal(racerProtected, true);
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(fs.existsSync(recoveryLockFile), false);
  assert.equal(listJobs(workspace)[0].id, "recovery-race-safe");
});

test("invalid state is not replaced with an empty writable state", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{", "utf8");

  assert.throws(() => upsertJob(workspace, { id: "lost", status: "queued" }), SyntaxError);
  assert.equal(fs.readFileSync(stateFile, "utf8"), "{");
});
