import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { loadState, readJobFile, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { makeTempDir } from "./helpers.mjs";

const STATE_MODULE = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;

test("locked cancellation wins a foreground completion race", { timeout: 5000 }, async (t) => {
  const workspaceRoot = makeTempDir();
  const jobId = "foreground-cancel-race";
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  const terminalWritten = new Int32Array(new SharedArrayBuffer(4));
  const originalRenameSync = fs.renameSync;

  fs.renameSync = (source, destination) => {
    const completed =
      path.resolve(destination) === path.resolve(jobFile) &&
      JSON.parse(fs.readFileSync(source, "utf8")).status === "completed";
    const result = originalRenameSync(source, destination);
    if (completed) {
      Atomics.store(terminalWritten, 0, 1);
      Atomics.notify(terminalWritten, 0);
    }
    return result;
  };
  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  let worker;
  let resolveLocked;
  let rejectLocked;
  let resolveDone;
  let rejectDone;
  let cancellationLocked = false;
  const locked = new Promise((resolve, reject) => {
    resolveLocked = resolve;
    rejectLocked = reject;
  });
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const execution = {
    exitStatus: 0,
    payload: { rawOutput: "completed" },
    rendered: "completed\n",
    summary: "completed"
  };

  const result = await runTrackedJob(
    { id: jobId, kind: "review", jobClass: "review", workspaceRoot },
    async () => {
      worker = new Worker(
        `const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { updateState, writeJobFile } = await import(workerData.stateModule);
  updateState(workerData.workspaceRoot, (state) => {
    const index = state.jobs.findIndex((job) => job.id === workerData.jobId);
    const current = state.jobs[index];
    if (index === -1 || current.status !== "running" || current.pid !== workerData.ownerPid) {
      throw new Error("Foreground job ownership was lost before cancellation acquired the lock.");
    }
    parentPort.postMessage("locked");
    Atomics.wait(new Int32Array(workerData.terminalWritten), 0, 0, 500);
    const terminating = {
      ...current,
      status: "terminating",
      phase: "cancelling",
      errorMessage: "Cancellation requested."
    };
    writeJobFile(workerData.workspaceRoot, workerData.jobId, terminating);
    state.jobs[index] = terminating;
  });
  parentPort.postMessage("done");
})().catch((error) => parentPort.postMessage({ error: error.stack }));`,
        {
          eval: true,
          workerData: {
            stateModule: STATE_MODULE,
            workspaceRoot,
            jobId,
            ownerPid: process.pid,
            terminalWritten: terminalWritten.buffer
          }
        }
      );
      t.after(() => worker.terminate());
      worker.on("message", (message) => {
        if (message === "locked") {
          cancellationLocked = true;
          resolveLocked();
        } else if (message === "done") {
          resolveDone();
        } else if (message?.error) {
          const error = new Error(message.error);
          (cancellationLocked ? rejectDone : rejectLocked)(error);
        }
      });
      worker.once("error", (error) => {
        (cancellationLocked ? rejectDone : rejectLocked)(error);
      });
      await locked;
      return execution;
    }
  );
  await done;

  const indexed = loadState(workspaceRoot).jobs.find((job) => job.id === jobId);
  const terminal = readJobFile(jobFile);
  assert.equal(result, execution);
  assert.equal(indexed.status, "terminating");
  assert.equal(terminal.status, "terminating");
  assert.equal(Object.hasOwn(terminal, "result"), false);
});
