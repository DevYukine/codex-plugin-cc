import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveJobFile, resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { createJobProgressUpdater, runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { probeProcess, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function readWorkerLease(pid) {
  const probe = probeProcess(pid);
  assert.equal(probe.liveness, "alive");
  assert.ok(probe.startIdentity);
  return { pid, startIdentity: probe.startIdentity };
}

function writeTrackedJobFixture(workspace, job, storedJob = job) {
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  const jobFile = path.join(jobsDir, `${job.id}.json`);
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(jobFile, JSON.stringify(storedJob), "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] })}\n`,
    "utf8"
  );
  return { stateDir, jobFile };
}

function installTaskWorkerSpawnMock() {
  const treeWorkerSource = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(
  process.env.CODEX_COMPANION_TEST_SPAWN_MARKER,
  JSON.stringify({ workerPid: process.pid, descendantPid: descendant.pid })
);
setInterval(() => {}, 1000);
`;
  const preload = path.join(makeTempDir(), "task-worker-spawn-mock.cjs");
  fs.writeFileSync(
    preload,
    `const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (!Array.isArray(args) || !args.includes("task-worker")) {
    return originalSpawn(command, args, options);
  }
  if (process.env.CODEX_COMPANION_TEST_SPAWN === "throw") {
    throw new Error("simulated synchronous worker spawn failure");
  }
  if (process.env.CODEX_COMPANION_TEST_SPAWN === "tree") {
    return originalSpawn(process.execPath, ["-e", ${JSON.stringify(treeWorkerSource)}], options);
  }
  const child = new EventEmitter();
  child.pid = null;
  child.connected = true;
  child.disconnect = () => { child.connected = false; };
  child.unref = () => child;
  process.nextTick(() => {
    if (process.env.CODEX_COMPANION_TEST_SPAWN === "error") {
      child.emit("error", new Error("simulated asynchronous worker spawn failure"));
    } else if (process.env.CODEX_COMPANION_TEST_SPAWN === "hang") {
      return;
    } else {
      child.emit("message", {
        type: "worker-lease",
        workerLease: { pid: process.pid, startIdentity: "mock" },
        cancelControl: { endpoint: "mock", token: "mock" }
      });
    }
  });
  return child;
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );
  return preload;
}

test("terminateProcessTree retries a Unix worker pid when its process group is missing", () => {
  for (const processExists of [true, false]) {
    const calls = [];
    const outcome = terminateProcessTree(1234, {
      platform: "linux",
      killImpl(pid, signal) {
        calls.push([pid, signal]);
        if (pid < 0 || !processExists) {
          const error = new Error("missing");
          error.code = "ESRCH";
          throw error;
        }
      }
    });

    assert.deepEqual(calls, [
      [-1234, "SIGTERM"],
      [1234, "SIGTERM"]
    ]);
    assert.equal(outcome.delivered, processExists);
    assert.equal(outcome.method, "process");
  }
});

function spawnCancellableFixture(cwd) {
  const source = `
const crypto = require("node:crypto");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const token = crypto.randomUUID();
const endpoint = process.platform === "win32"
  ? "\\\\\\\\.\\\\pipe\\\\codex-companion-test-\${token}"
  : path.join(os.tmpdir(), \`codex-companion-test-\${token}.sock\`);
const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let request = "";
  socket.on("data", (chunk) => {
    request += chunk;
    if (request !== token && request.length < token.length) return;
    if (request !== token) return socket.end("denied");
    socket.once("close", () => process.kill(process.pid, "SIGTERM"));
    socket.end("accepted");
  });
});
server.listen(endpoint, () => process.stdout.write(JSON.stringify({ endpoint, token }) + "\\n"));
setInterval(() => {}, 1000);
`;
  const child = spawn(process.execPath, ["-e", source], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  });
  return new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline === -1) {
        return;
      }
      child.stdout.destroy();
      child.unref();
      resolve({ child, cancelControl: JSON.parse(output.slice(0, newline)) });
    });
  });
}

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).threadOperations, []);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("transfer delegates the current Claude session directly to native import", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/codex:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "codex resume thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Native transfer");
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/codex:transfer"]
  );
  assert.deepEqual(fakeState.threadOperations, []);
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-fails");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("adversarial review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).threadOperations, []);
});

test("adversarial review accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when the app server returns it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i);
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
});

test("task --resume-last transparently unarchives and rearchives a persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  const initialJob = state.jobs.find((job) => job.request.prompt === "initial task");
  const resumedJob = state.jobs.find((job) => job.request.prompt === "follow up");
  assert.equal(initialJob.threadArchived, true);
  assert.equal(resumedJob.threadArchived, true);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(repo, initialJob.id), "utf8")).result.threadArchived, true);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(repo, resumedJob.id), "utf8")).result.threadArchived, true);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.threadOperations, [
    { method: "thread/archive", threadId: "thr_1" },
    { method: "thread/unarchive", threadId: "thr_1" },
    { method: "thread/archive", threadId: "thr_1" }
  ]);
  assert.ok(
    fakeState.calls.findIndex((call) => call.method === "turn/completed") <
      fakeState.calls.findIndex((call) => call.method === "thread/archive")
  );
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --wait --resume starts a resumed turn when no task is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--wait", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

test("task --wait archives its persistent thread after completion", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--wait", "--json", "inspect the worker lifecycle"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 0);
  assert.match(payload.rawOutput, /Handled the requested task/);
  assert.equal(payload.threadArchived, true);

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "completed");
  assert.equal(state.jobs[0].request.prompt, "inspect the worker lifecycle");
  assert.equal(state.jobs[0].request.jobId, state.jobs[0].id);
  assert.equal(state.jobs[0].threadArchived, true);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(repo, state.jobs[0].id), "utf8")).result.threadArchived, true);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "inspect the worker lifecycle");
  assert.deepEqual(fakeState.threadOperations, [{ method: "thread/archive", threadId: "thr_1" }]);
  assert.ok(
    fakeState.calls.findIndex((call) => call.method === "turn/completed") <
      fakeState.calls.findIndex((call) => call.method === "thread/archive")
  );
});

test("archive failure preserves task output and is not unarchived on resume", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);

  const failedArchiveEnv = { ...buildEnv(binDir), CODEX_COMPANION_TEST_ARCHIVE_FAIL: "1" };
  const first = run("node", [SCRIPT, "task", "--wait", "--json", "preserve this result"], {
    cwd: repo,
    env: failedArchiveEnv
  });
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.match(firstPayload.rawOutput, /Handled the requested task/);
  assert.equal(firstPayload.threadArchived, false);
  assert.match(firstPayload.threadArchiveError, /thread\/archive failed/);

  const resumed = run("node", [SCRIPT, "task", "--wait", "--json", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumedPayload = JSON.parse(resumed.stdout);
  assert.equal(resumedPayload.threadArchived, true);
  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  const initialJob = state.jobs.find((job) => job.request.prompt === "preserve this result");
  const resumedJob = state.jobs.find((job) => job.request.prompt === "follow up");
  assert.equal(initialJob.status, "completed");
  assert.equal(initialJob.threadArchived, false);
  assert.match(initialJob.threadArchiveError, /thread\/archive failed/);
  const storedInitialJob = JSON.parse(fs.readFileSync(resolveJobFile(repo, initialJob.id), "utf8"));
  const storedResumedJob = JSON.parse(fs.readFileSync(resolveJobFile(repo, resumedJob.id), "utf8"));
  assert.equal(storedInitialJob.result.threadArchived, false);
  assert.match(storedInitialJob.result.threadArchiveError, /thread\/archive failed/);
  assert.match(storedInitialJob.result.rawOutput, /Handled the requested task/);
  assert.equal(storedResumedJob.result.threadArchived, true);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.calls.some((call) => call.method === "thread/unarchive"), false);
  assert.deepEqual(fakeState.threadOperations, [{ method: "thread/archive", threadId: "thr_1" }]);
});

test("archive timeout preserves task output", { timeout: 15000 }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--wait", "--json", "preserve timed out archive output"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_TEST_ARCHIVE_HANG: "1" }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.rawOutput, /Handled the requested task/);
  assert.equal(payload.threadArchived, false);
  assert.match(payload.threadArchiveError, /thread\/archive timed out after 1000ms/);
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "low");
});

test("write tasks disable multi-agent for fresh and resumed threads only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);

  let result = run("node", [SCRIPT, "task", "--fresh", "read-only fresh"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  let fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(Object.hasOwn(fakeState.lastThreadStart, "config"), false);

  result = run("node", [SCRIPT, "task", "--resume", "read-only resume"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(Object.hasOwn(fakeState.lastThreadResume, "config"), false);

  result = run("node", [SCRIPT, "task", "--fresh", "--write", "write fresh"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart.config, { features: { multi_agent: false } });

  result = run("node", [SCRIPT, "task", "--resume", "--write", "write resume"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadResume.config, { features: { multi_agent: false } });
});

test("task routes apply built-ins, overrides, and explicit selections independently", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildEnv(binDir);

  let result = run("node", [SCRIPT, "task", "--route", "mechanical", "route default"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  let fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.6-luna");
  assert.equal(fakeState.lastTurnStart.effort, "low");

  result = run("node", [SCRIPT, "setup", "--route", "implementation", "--model", "custom-model"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  result = run("node", [SCRIPT, "task", "--route", "implementation", "--effort", "medium", "partial override"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "custom-model");
  assert.equal(fakeState.lastTurnStart.effort, "medium");

  result = run("node", [SCRIPT, "task", "--route", "architecture", "architecture route"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.effort, "max");

  result = run("node", [SCRIPT, "task", "--route", "parallel", "parallel route"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.6-sol");
  assert.equal(fakeState.lastTurnStart.effort, "max");
});

test("task route setup clears overrides and rejects invalid routes", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildEnv(binDir);

  let result = run("node", [SCRIPT, "setup", "--route", "implementation", "--model", "custom-model"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  result = run("node", [SCRIPT, "setup", "--route", "implementation", "--clear"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  result = run("node", [SCRIPT, "task", "--route", "implementation", "cleared route"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.6-sol");
  assert.equal(fakeState.lastTurnStart.effort, "high");

  const stateFile = path.join(resolveStateDir(repo), "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.config.taskRoutes = { custom: {} };
  fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`, "utf8");
  result = run("node", [SCRIPT, "task", "--route", "custom", "invalid route"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Custom task route "custom" must define a model or effort/);

  result = run("node", [SCRIPT, "setup", "--model", "orphan-model"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /require `--route <name>`/);
});

test("task routes reject inherited built-in property names without partial setup changes", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);

  const baseline = run("node", [SCRIPT, "setup", "--disable-review-gate"], { cwd: repo, env });
  assert.equal(baseline.status, 0, baseline.stderr);

  for (const routeName of ["constructor", "toString", "__proto__"]) {
    const result = run("node", [SCRIPT, "task", "--route", routeName, "invalid route"], { cwd: repo, env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Unknown task route "${routeName}"`));
  }

  const result = run(
    "node",
    [SCRIPT, "setup", "--enable-review-gate", "--route", "constructor"],
    { cwd: repo, env }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Custom task route "constructor" must define a model or effort/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8")).config.stopReviewGate, false);
});

test("task without a route preserves null settings and resume keeps prior settings", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildEnv(binDir);

  let result = run("node", [SCRIPT, "task", "no route"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  let fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, null);
  assert.equal(fakeState.lastTurnStart.effort, null);

  result = run("node", [SCRIPT, "task", "--model", "saved-model", "--effort", "high", "configured"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  result = run("node", [SCRIPT, "task", "--resume-last", "continue"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "saved-model");
  assert.equal(fakeState.lastTurnStart.effort, "high");
  let companionState = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(companionState.jobs[0].request.model, "saved-model");
  assert.equal(companionState.jobs[0].request.effort, "high");

  result = run("node", [SCRIPT, "task", "--resume-last", "--model", "override-model", "override"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "override-model");
  assert.equal(fakeState.lastTurnStart.effort, "high");
  companionState = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(companionState.jobs[0].request.model, "override-model");
  assert.equal(companionState.jobs[0].request.effort, "high");
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).threadOperations, [
    { method: "thread/archive", threadId: "thr_1" }
  ]);
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task using the shared broker still completes when Codex spawns subagents", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("only one task worker can claim a queued job", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  const preload = installTaskWorkerSpawnMock();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  const env = buildEnv(binDir);
  const launchEnv = {
    ...env,
    CODEX_COMPANION_TEST_SPAWN: "noop",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim()
  };

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "claim once"], {
    cwd: repo,
    env: launchEnv
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const stateDir = resolveStateDir(repo);
  const stateFile = path.join(stateDir, "state.json");
  const jobFile = path.join(stateDir, "jobs", `${jobId}.json`);
  const queuedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const queuedJob = queuedState.jobs.find((job) => job.id === jobId);
  delete queuedJob.workerLease;
  delete queuedJob.cancelControl;
  fs.writeFileSync(stateFile, `${JSON.stringify(queuedState)}\n`, "utf8");
  const storedQueuedJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  delete storedQueuedJob.workerLease;
  delete storedQueuedJob.cancelControl;
  fs.writeFileSync(jobFile, JSON.stringify(storedQueuedJob), "utf8");

  const workers = [1, 2].map(
    () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], {
          cwd: repo,
          env,
          stdio: "ignore",
          windowsHide: true
        });
        child.once("error", reject);
        child.once("exit", resolve);
      })
  );
  assert.deepEqual(await Promise.all(workers), [0, 0]);

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.jobs.find((job) => job.id === jobId).status, "completed");
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.nextTurnId, 2);
});

test("a cancelled queued job cannot be claimed by a task worker", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  const preload = installTaskWorkerSpawnMock();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);
  const launchEnv = {
    ...env,
    CODEX_COMPANION_TEST_SPAWN: "noop",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim()
  };

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "cancel before claim"], {
    cwd: repo,
    env: launchEnv
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  const cancelled = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const worker = run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], { cwd: repo, env });
  assert.equal(worker.status, 0, worker.stderr);

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.jobs.find((job) => job.id === jobId).status, "cancelled");
  if (fs.existsSync(statePath)) {
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart, undefined);
  }
});

test("task worker setup failures finalize only their queued or claimed job", () => {
  for (const payload of ["missing", "corrupt"]) {
    const repo = makeTempDir();
    const stateDir = resolveStateDir(repo);
    const jobsDir = path.join(stateDir, "jobs");
    const jobId = `task-${payload}`;
    const logFile = path.join(jobsDir, `${jobId}.log`);
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(logFile, "queued\n", "utf8");
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        version: 1,
        config: { stopReviewGate: false },
        jobs: [{ id: jobId, kind: "task", jobClass: "task", status: "queued", phase: "queued", logFile }]
      })}\n`,
      "utf8"
    );
    if (payload === "corrupt") {
      fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify({ id: jobId, request: "invalid" }), "utf8");
    }

    const result = run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], { cwd: repo });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Task worker ${jobId} failed before execution:`));
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    assert.equal(state.jobs[0].status, "failed");
    assert.equal(state.jobs[0].phase, "failed");
    assert.equal(state.jobs[0].pid, null);
    assert.match(state.jobs[0].errorMessage, /failed before execution/);
    const storedJob = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), "utf8"));
    assert.equal(storedJob.status, "failed");
    assert.match(fs.readFileSync(logFile, "utf8"), /failed before execution/);
  }

  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [{ id: "task-other", kind: "task", jobClass: "task", status: "running", pid: process.pid }]
    })}\n`,
    "utf8"
  );
  const result = run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", "task-other"], { cwd: repo });
  assert.equal(result.status, 1);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
  assert.equal(state.jobs[0].pid, process.pid);
});

test("postclaim task worker setup failure is finalized", () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  const jobId = "task-postclaim";
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const preload = path.join(makeTempDir(), "postclaim-job-write-failure.cjs");
  const request = { cwd: repo, prompt: "never start", write: false, resumeLast: false, jobId };
  const job = { id: jobId, kind: "task", jobClass: "task", status: "queued", phase: "queued", logFile, request };
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(logFile, "queued\n", "utf8");
  fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    preload,
    `const fs = require("node:fs");
const path = require("node:path");
const originalRenameSync = fs.renameSync;
const jobFile = path.resolve(${JSON.stringify(jobFile)});
let failed = false;
fs.renameSync = function (source, destination) {
  if (!failed && path.resolve(destination) === jobFile) {
    failed = true;
    const error = new Error("simulated postclaim job write failure");
    error.code = "EACCES";
    throw error;
  }
  return originalRenameSync(source, destination);
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], {
    cwd: repo,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim()
    }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /simulated postclaim job write failure/);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].phase, "failed");
  assert.equal(state.jobs[0].pid, null);
  const storedJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(storedJob.status, "failed");
  assert.equal(storedJob.pid, null);
});

test("initial runTrackedJob state write failure is finalized", () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  const stateFile = path.join(stateDir, "state.json");
  const jobId = "task-tracked-startup";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const preload = path.join(makeTempDir(), "tracked-startup-write-failure.cjs");
  const request = { cwd: repo, prompt: "never start", write: false, resumeLast: false, jobId };
  const job = { id: jobId, kind: "task", jobClass: "task", status: "queued", phase: "queued", logFile, request };
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(logFile, "queued\n", "utf8");
  fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify(job), "utf8");
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    preload,
    `const fs = require("node:fs");
const path = require("node:path");
const originalRenameSync = fs.renameSync;
const stateFile = path.resolve(${JSON.stringify(stateFile)});
let stateWrites = 0;
fs.renameSync = function (source, destination) {
  if (path.resolve(destination) === stateFile && ++stateWrites === 2) {
    const error = new Error("simulated initial runTrackedJob state update failure");
    error.code = "EACCES";
    throw error;
  }
  return originalRenameSync(source, destination);
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], {
    cwd: repo,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim()
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /simulated initial runTrackedJob state update failure/);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].phase, "failed");
  assert.equal(state.jobs[0].pid, null);
  assert.match(state.jobs[0].errorMessage, /simulated initial runTrackedJob state update failure/);
  assert.equal(typeof state.jobs[0].completedAt, "string");
  const storedJob = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), "utf8"));
  assert.equal(storedJob.status, "failed");
  assert.match(fs.readFileSync(logFile, "utf8"), /simulated initial runTrackedJob state update failure/);
});

test("preclaimed tracked jobs stop when task ownership is lost", async () => {
  const seedJob = (status, pid) => {
    const repo = makeTempDir();
    const stateDir = resolveStateDir(repo);
    const jobsDir = path.join(stateDir, "jobs");
    const id = `task-owned-${status}-${pid}`;
    const logFile = path.join(jobsDir, `${id}.log`);
    const job = { id, kind: "task", jobClass: "task", status, phase: status, pid, logFile };
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(logFile, "owned\n", "utf8");
    fs.writeFileSync(path.join(jobsDir, `${id}.json`), JSON.stringify(job), "utf8");
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] })}\n`,
      "utf8"
    );
    return { repo, stateDir, jobsDir, job };
  };

  for (const [status, pid] of [
    ["cancelled", null],
    ["running", process.pid + 100000]
  ]) {
    const { repo, stateDir, job } = seedJob(status, pid);
    let runnerCalls = 0;
    const result = await runTrackedJob(
      { ...job, status: "running", pid: process.pid, workspaceRoot: repo },
      async () => {
        runnerCalls += 1;
      },
      { logFile: job.logFile, preclaimedPid: process.pid }
    );
    assert.equal(result, null);
    assert.equal(runnerCalls, 0);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    assert.equal(state.jobs[0].status, status);
    assert.equal(state.jobs[0].pid, pid);
  }

  const fileFirst = seedJob("running", process.pid);
  const cancelledBeforeStart = { ...fileFirst.job, status: "cancelled", phase: "cancelled", pid: null };
  fs.writeFileSync(
    path.join(fileFirst.jobsDir, `${fileFirst.job.id}.json`),
    JSON.stringify(cancelledBeforeStart),
    "utf8"
  );
  let startupRunnerCalls = 0;
  const startupResult = await runTrackedJob(
    { ...fileFirst.job, workspaceRoot: fileFirst.repo },
    async () => {
      startupRunnerCalls += 1;
    },
    { logFile: fileFirst.job.logFile, preclaimedPid: process.pid }
  );
  assert.equal(startupResult, null);
  assert.equal(startupRunnerCalls, 0);

  const { repo, stateDir, jobsDir, job } = seedJob("running", process.pid);
  const progress = createJobProgressUpdater(repo, job.id, { preclaimedPid: process.pid });
  let runnerCalls = 0;
  let finishCancellation;
  const cancellation = new Promise((resolve) => {
    finishCancellation = resolve;
  });
  const execution = { exitStatus: 0, payload: { rawOutput: "done" }, rendered: "done\n", summary: "done" };
  const result = await runTrackedJob(
    { ...job, workspaceRoot: repo },
    async () => {
      runnerCalls += 1;
      const cancelled = { ...job, status: "cancelled", phase: "cancelled", pid: null };
      fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), JSON.stringify(cancelled), "utf8");
      progress({ phase: "responding", threadId: "thread-ignored", turnId: "turn-ignored" });
      setTimeout(() => {
        fs.writeFileSync(
          path.join(stateDir, "state.json"),
          `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [cancelled] })}\n`,
          "utf8"
        );
        finishCancellation();
      }, 0);
      return execution;
    },
    { logFile: job.logFile, preclaimedPid: process.pid }
  );
  await cancellation;
  assert.equal(result, execution);
  assert.equal(runnerCalls, 1);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
  assert.equal(state.jobs[0].phase, "cancelled");
  assert.equal(state.jobs[0].threadId, undefined);
  const storedJob = JSON.parse(fs.readFileSync(path.join(jobsDir, `${job.id}.json`), "utf8"));
  assert.equal(storedJob.status, "cancelled");
  assert.equal(storedJob.result, undefined);
});

test("owned terminal files reconcile after a one-shot state save failure", async () => {
  for (const exitStatus of [0, 1]) {
    const repo = makeTempDir();
    const stateDir = resolveStateDir(repo);
    const jobsDir = path.join(stateDir, "jobs");
    const stateFile = path.join(stateDir, "state.json");
    const jobId = `task-reconcile-${exitStatus}`;
    const logFile = path.join(jobsDir, `${jobId}.log`);
    const job = {
      id: jobId,
      kind: "task",
      jobClass: "task",
      status: "running",
      phase: "starting",
      pid: process.pid,
      logFile
    };
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(logFile, "running\n", "utf8");
    fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify(job), "utf8");
    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] })}\n`,
      "utf8"
    );

    const originalRenameSync = fs.renameSync;
    let stateWrites = 0;
    fs.renameSync = (source, destination) => {
      if (path.resolve(destination) === path.resolve(stateFile) && ++stateWrites === 2) {
        const error = new Error("simulated terminal state save failure");
        error.code = "EACCES";
        throw error;
      }
      return originalRenameSync(source, destination);
    };
    const execution = {
      exitStatus,
      threadId: `thread-${exitStatus}`,
      turnId: `turn-${exitStatus}`,
      payload: { rawOutput: `result-${exitStatus}` },
      rendered: `result-${exitStatus}\n`,
      summary: `result-${exitStatus}`
    };
    let result;
    try {
      result = await runTrackedJob(
        { ...job, workspaceRoot: repo },
        async () => execution,
        { logFile, preclaimedPid: process.pid }
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(result, execution);
    const expectedStatus = exitStatus === 0 ? "completed" : "failed";
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.jobs[0].status, expectedStatus);
    assert.equal(state.jobs[0].pid, null);
    assert.equal(state.jobs[0].threadId, execution.threadId);
    const storedJob = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), "utf8"));
    assert.equal(storedJob.status, expectedStatus);
    assert.equal(storedJob.ownerPid, process.pid);
    assert.deepEqual(storedJob.result, execution.payload);
  }
});

test("task worker spawn failures mark the queued job failed", () => {
  const preload = installTaskWorkerSpawnMock();

  for (const mode of ["throw", "error"]) {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    installFakeCodex(binDir);
    initGitRepo(repo);
    const env = buildEnv(binDir);
    const result = run("node", [SCRIPT, "task", "--background", "--json", "fail to spawn"], {
      cwd: repo,
      env: {
        ...env,
        CODEX_COMPANION_TEST_SPAWN: mode,
        NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim()
      }
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Failed to start detached task worker/);
    assert.match(result.stderr, /simulated (synchronous|asynchronous) worker spawn failure/);
    const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].status, "failed");
    assert.equal(state.jobs[0].phase, "failed");
    assert.match(state.jobs[0].errorMessage, /Failed to start detached task worker/);
    const storedJob = JSON.parse(
      fs.readFileSync(path.join(resolveStateDir(repo), "jobs", `${state.jobs[0].id}.json`), "utf8")
    );
    assert.equal(storedJob.status, "failed");
    assert.equal(storedJob.errorMessage, state.jobs[0].errorMessage);
  }
});

test("task worker lease handshake timeout terminates the detached process tree and finalizes the queued job", { timeout: 20000, skip: process.platform !== "linux" }, async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const marker = path.join(repo, "worker-tree.json");
  const preload = installTaskWorkerSpawnMock();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);
  let pids = [];
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });

  const result = run("node", [SCRIPT, "task", "--background", "--json", "never handshakes"], {
    cwd: repo,
    env: {
      ...env,
      CODEX_COMPANION_TEST_SPAWN: "tree",
      CODEX_COMPANION_TEST_SPAWN_MARKER: marker,
      NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim()
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not provide a valid lease handshake within 5000ms/);
  const { workerPid, descendantPid } = JSON.parse(fs.readFileSync(marker, "utf8"));
  pids = [workerPid, descendantPid];
  await waitFor(() => pids.every((pid) => probeProcess(pid).liveness === "gone"), {
    timeoutMs: 5000,
    intervalMs: 25
  });
  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, "failed");
  const stored = JSON.parse(
    fs.readFileSync(path.join(resolveStateDir(repo), "jobs", `${state.jobs[0].id}.json`), "utf8")
  );
  assert.equal(stored.status, "failed");
  assert.equal(stored.errorMessage, state.jobs[0].errorMessage);
});

test("task launcher accepts only the worker's lease handshake", { skip: process.platform !== "linux" }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const preload = path.join(repo, "forbid-parent-pid-probe.cjs");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    preload,
    `const fs = require("node:fs");
const originalRead = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  if (/^\\/proc\\/\\d+\\/stat$/.test(String(file)) && String(file) !== \`/proc/\${process.pid}/stat\`) {
    throw new Error("parent sampled the child pid");
  }
  return originalRead.call(this, file, ...args);
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );
  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "use the handshake"], {
    cwd: repo,
    env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim() }
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const completed = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).job.status, "completed");
});

test("task worker cannot overwrite a concurrent terminal file with its running claim", { skip: process.platform !== "linux" }, () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  const stateFile = path.join(stateDir, "state.json");
  const jobId = "task-claim-terminal-race";
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const request = { cwd: repo, prompt: "must not run", write: false, resumeLast: false, jobId };
  const job = { id: jobId, kind: "task", jobClass: "task", status: "queued", phase: "queued", request };
  const preload = path.join(repo, "terminal-after-state-rename.cjs");
  writeTrackedJobFixture(repo, job);
  fs.writeFileSync(
    preload,
    `const fs = require("node:fs");
const path = require("node:path");
const originalRename = fs.renameSync;
let injected = false;
fs.renameSync = function (source, destination) {
  let running = null;
  if (!injected && path.resolve(destination) === path.resolve(${JSON.stringify(stateFile)})) {
    try {
      running = JSON.parse(fs.readFileSync(source, "utf8")).jobs.find((job) => job.id === ${JSON.stringify(jobId)} && job.status === "running");
    } catch {}
  }
  const result = originalRename.apply(this, arguments);
  if (running) {
    injected = true;
    fs.writeFileSync(${JSON.stringify(jobFile)}, JSON.stringify({
      ...running,
      status: "completed",
      phase: "done",
      pid: null,
      ownerPid: running.workerLease.pid,
      ownerLease: running.workerLease,
      completedAt: "2026-07-14T12:00:00.000Z",
      result: { rawOutput: "won race" },
      rendered: "won race\\n"
    }));
  }
  return result;
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );

  const worker = run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], {
    cwd: repo,
    env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }
  });
  assert.equal(worker.status, 0, worker.stderr);
  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "completed");
  assert.deepEqual(stored.result, { rawOutput: "won race" });
});

test("task --wait --resume repeatedly attaches to one active task without consuming its prompt", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "original prompt"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const stateDir = resolveStateDir(repo);
  await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    return state.jobs.find((job) => job.id === jobId && job.status === "running" && job.turnId) ?? null;
  }, { timeoutMs: 15000 });

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: repo, env });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).candidate.id, jobId);
  assert.equal(JSON.parse(candidate.stdout).candidate.status, "running");

  for (const prompt of ["ignored first prompt", "ignored second prompt"]) {
    const attached = run(
      "node",
      [SCRIPT, "task", "--wait", "--resume", "--timeout-ms", "25", "--json", prompt],
      { cwd: repo, env }
    );
    assert.equal(attached.status, 0, attached.stderr);
    const payload = JSON.parse(attached.stdout);
    assert.equal(payload.jobId, jobId);
    assert.equal(payload.waitTimedOut, true);
  }

  const timedOut = run(
    "node",
    [SCRIPT, "task", "--wait", "--resume", "--timeout-ms", "25", "ignored text prompt"],
    { cwd: repo, env }
  );
  assert.equal(timedOut.status, 0, timedOut.stderr);
  assert.match(timedOut.stdout, new RegExp(`^jobId: ${jobId}$`, "m"));
  assert.match(timedOut.stdout, /^status: running$/m);
  assert.match(timedOut.stdout, /^waitTimedOut: true$/m);

  let fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.nextTurnId, 2);
  assert.equal(fakeState.lastTurnStart.prompt, "original prompt");

  const completed = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).job.status, "completed");
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.nextTurnId, 2);
  assert.equal(fakeState.lastTurnStart.prompt, "original prompt");
});

test("a foreground task survives its waiter exiting", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  const env = buildEnv(binDir);
  const waiter = spawn(process.execPath, [SCRIPT, "task", "--json", "outlive the waiter"], {
    cwd: repo,
    env,
    stdio: "ignore",
    windowsHide: true
  });

  const stateDir = resolveStateDir(repo);
  const job = await waitFor(() => {
    const stateFile = path.join(stateDir, "state.json");
    if (!fs.existsSync(stateFile)) {
      return null;
    }
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return state.jobs.find((candidate) => candidate.status === "running" && candidate.turnId) ?? null;
  }, { timeoutMs: 15000 });

  waiter.kill();
  await new Promise((resolve) => waiter.once("exit", resolve));

  const completed = run("node", [SCRIPT, "status", job.id, "--wait", "--timeout-ms", "15000", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).job.status, "completed");

  const result = run("node", [SCRIPT, "result", job.id, "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).storedJob.result.rawOutput, /Handled the requested task/);
});

test("task --wait --resume rejects ambiguous active tasks", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: ["first", "second"].map((id) => ({
        id: `task-${id}`,
        kind: "task",
        jobClass: "task",
        status: "running",
        sessionId: "sess-current",
        updatedAt: `2026-07-14T12:00:0${id === "first" ? 1 : 2}.000Z`
      }))
    }, null, 2)}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const result = run("node", [SCRIPT, "task", "--wait", "--resume", "ignored"], {
    cwd: workspace,
    env
  });

  assert.equal(result.status, 1);
  const expectedError =
    "Multiple Codex tasks are active for this session. Use /codex:status with a job id instead of guessing which task to attach.\n";
  assert.equal(result.stderr, expectedError);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: workspace, env });
  assert.equal(candidate.status, 1);
  assert.equal(candidate.stderr, expectedError);
});

test("background task resume resolves and persists inherited and overridden settings", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);

  const initial = run("node", [SCRIPT, "task", "--model", "saved-model", "--effort", "high", "initial task"], {
    cwd: repo,
    env
  });
  assert.equal(initial.status, 0, initial.stderr);

  const resume = (selection, expectedModel, expectedEffort) => {
    const launched = run(
      "node",
      [SCRIPT, "task", "--background", "--json", "--resume-last", ...selection, "continue"],
      { cwd: repo, env }
    );
    assert.equal(launched.status, 0, launched.stderr);
    const jobId = JSON.parse(launched.stdout).jobId;
    const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"], {
      cwd: repo,
      env
    });
    assert.equal(waited.status, 0, waited.stderr);
    assert.equal(JSON.parse(waited.stdout).job.status, "completed");

    const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(fakeState.lastTurnStart.model, expectedModel);
    assert.equal(fakeState.lastTurnStart.effort, expectedEffort);

    const result = run("node", [SCRIPT, "result", jobId, "--json"], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.job.request, payload.storedJob.request);
    assert.equal(payload.storedJob.request.model, expectedModel);
    assert.equal(payload.storedJob.request.effort, expectedEffort);
  };

  resume([], "saved-model", "high");
  resume(["--route", "mechanical"], "gpt-5.6-luna", "low");
  resume(["--model", "override-model"], "override-model", "low");
  resume(["--effort", "xhigh"], "override-model", "xhigh");
});

test("failed background task resume persists resolved settings", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);

  const initial = run("node", [SCRIPT, "task", "--model", "saved-model", "--effort", "high", "initial task"], {
    cwd: repo,
    env
  });
  assert.equal(initial.status, 0, initial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fakeState.threads = [];
  fs.writeFileSync(statePath, `${JSON.stringify(fakeState, null, 2)}\n`, "utf8");

  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "--resume-last", "--route", "mechanical", "continue"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "failed");

  const result = run("node", [SCRIPT, "result", jobId, "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.job.request, payload.storedJob.request);
  assert.equal(payload.storedJob.request.model, "gpt-5.6-luna");
  assert.equal(payload.storedJob.request.effort, "low");
});

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/codex:adversarial-review focus on auth/i);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.codex.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Codex Status/);
  assert.match(status.stdout, /Codex Review/);
  assert.match(status.stdout, /completed/);
});

test("foreground reviews persist their worker lease", { skip: process.platform !== "linux" }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "initial\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n", "utf8");

  const review = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(review.status, 0, review.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  const job = state.jobs.find((candidate) => candidate.jobClass === "review");
  assert.equal(job.status, "completed");
  assert.equal(Number.isInteger(job.workerLease.pid), true);
  assert.match(job.workerLease.startIdentity, /^linux:/);
  const stored = JSON.parse(
    fs.readFileSync(path.join(resolveStateDir(repo), "jobs", `${job.id}.json`), "utf8")
  );
  assert.deepEqual(stored.workerLease, job.workerLease);
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/codex:status review-live`<br>`\/codex:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /Codex session ID: thr_1/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_1/);
  assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-adv-live",
            kind: "adversarial-review",
            status: "running",
            title: "Codex Adversarial Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_adv_live",
            summary: "Adversarial review current changes",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-adv",
            kind: "adversarial-review",
            status: "completed",
            title: "Codex Adversarial Review",
            jobClass: "review",
            threadId: "thr_adv_done",
            summary: "Adversarial review working tree diff",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  assert.match(result.stdout, /Codex session ID: thr_adv_live/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("status --wait reconciles exited worker leases", () => {
  for (const status of ["queued", "running", "terminating"]) {
    const workspace = makeTempDir();
    const stateDir = resolveStateDir(workspace);
    const jobsDir = path.join(stateDir, "jobs");
    const jobId = `task-exited-${status}`;
    const jobFile = path.join(jobsDir, `${jobId}.json`);
    const job = {
      id: jobId,
      status,
      phase: status,
      title: "Codex Task",
      jobClass: "task",
      pid: 2147483647,
      workerLease: { pid: 2147483647, startIdentity: "stale" }
    };
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] })}\n`,
      "utf8"
    );

    const result = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "1000", "--json"], {
      cwd: workspace
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const expectedStatus = status === "terminating" ? "cancelled" : "failed";
    assert.equal(payload.job.status, expectedStatus);
    assert.equal(payload.waitTimedOut, false);
    const stateJob = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0];
    const storedJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    assert.equal(stateJob.status, expectedStatus);
    assert.equal(stateJob.pid, null);
    assert.equal(storedJob.status, expectedStatus);
    assert.equal(storedJob.pid, null);
  }
});

test("process leases use native subsecond creation identities on macOS and Windows", () => {
  const cases = [
    {
      platform: "darwin",
      command: "/usr/bin/osascript",
      output: "0:1752496496:654321",
      identity: "darwin:0:1752496496:654321"
    },
    {
      platform: "win32",
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Process -Id 4242 -ErrorAction Stop).StartTime.ToFileTimeUtc()"
      ],
      output: "133970123456789012",
      identity: "win32:133970123456789012"
    }
  ];

  for (const probe of cases) {
    const workspace = makeTempDir();
    const pluginData = path.join(workspace, "plugin-data");
    const marker = path.join(workspace, "probe.json");
    const terminationMarker = path.join(workspace, "terminated.json");
    const preload = path.join(workspace, "process-probe.cjs");
    fs.writeFileSync(
      preload,
      `const fs = require("node:fs");
const childProcess = require("node:child_process");
const originalSpawnSync = childProcess.spawnSync;
const originalKill = process.kill.bind(process);
let terminated = false;
Object.defineProperty(process, "platform", { value: ${JSON.stringify(probe.platform)} });
process.kill = function (pid, signal) {
  if (Math.abs(pid) === 4242) {
    if (signal === 0) {
      if (!terminated) return true;
      const error = new Error("missing");
      error.code = "ESRCH";
      throw error;
    }
    terminated = true;
    fs.writeFileSync(${JSON.stringify(terminationMarker)}, JSON.stringify({ pid }));
    return true;
  }
  return originalKill(pid, signal);
};
childProcess.spawnSync = function (command, args, options) {
  if (String(command).toLowerCase().includes("taskkill") && args.includes("4242")) {
    terminated = true;
    fs.writeFileSync(${JSON.stringify(terminationMarker)}, JSON.stringify({ pid: 4242 }));
    return { status: 0, signal: null, error: null, stdout: "", stderr: "" };
  }
  if (command !== ${JSON.stringify(probe.command)}) return originalSpawnSync(command, args, options);
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ command, args }));
  return {
    status: 0,
    signal: null,
    error: null,
    stdout: ${JSON.stringify(`${probe.output}\n`)},
    stderr: ""
  };
};
require("node:module").syncBuiltinESMExports();
`,
      "utf8"
    );
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginData,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim()
    };
    const job = {
      id: `task-${probe.platform}-identity`,
      kind: "task",
      jobClass: "task",
      status: "running",
      pid: 4242,
      workerLease: { pid: 4242, startIdentity: probe.identity }
    };
    const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    try {
      writeTrackedJobFixture(workspace, job);
      const live = run("node", [SCRIPT, "status", job.id, "--wait", "--timeout-ms", "0", "--json"], {
        cwd: workspace,
        env
      });
      assert.equal(live.status, 0, live.stderr);
      assert.equal(JSON.parse(live.stdout).job.status, "running");

      const stale = { ...job, workerLease: { pid: 4242, startIdentity: `${probe.identity}:stale` } };
      writeTrackedJobFixture(workspace, stale);
      const replaced = run("node", [SCRIPT, "status", job.id, "--wait", "--timeout-ms", "0", "--json"], {
        cwd: workspace,
        env
      });
      assert.equal(replaced.status, 0, replaced.stderr);
      assert.equal(JSON.parse(replaced.stdout).job.status, "failed");
      const observedProbe = JSON.parse(fs.readFileSync(marker, "utf8"));
      assert.equal(observedProbe.command, probe.command);
      if (probe.platform === "darwin") {
        assert.deepEqual(observedProbe.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
        assert.match(observedProbe.args[3], /proc_pidinfo/);
        assert.equal(observedProbe.args[4], "4242");
      } else {
        assert.deepEqual(observedProbe.args, probe.args);
      }

      const sessionJob = {
        ...job,
        id: `review-${probe.platform}-identity`,
        kind: "review",
        jobClass: "review",
        sessionId: "sess-current",
        workerLease: { pid: 4242, startIdentity: probe.identity }
      };
      writeTrackedJobFixture(workspace, sessionJob);
      const ended = run("node", [SESSION_HOOK, "SessionEnd"], {
        cwd: workspace,
        env,
        input: JSON.stringify({
          hook_event_name: "SessionEnd",
          session_id: "sess-current",
          cwd: workspace
        })
      });
      assert.equal(ended.status, 0, ended.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspace), "state.json"), "utf8")).jobs, []);
      assert.equal(fs.existsSync(terminationMarker), true);
    } finally {
      if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
});

test("macOS process probes fail closed on invalid proc_pidinfo output", () => {
  const workspace = makeTempDir();
  const marker = path.join(workspace, "probe.json");
  const preload = path.join(workspace, "process-probe.cjs");
  fs.writeFileSync(
    preload,
    `const fs = require("node:fs");
const childProcess = require("node:child_process");
const originalSpawnSync = childProcess.spawnSync;
const originalKill = process.kill.bind(process);
Object.defineProperty(process, "platform", { value: "darwin" });
process.kill = function (pid, signal) {
  if (pid === 4242 && signal === 0) return true;
  return originalKill(pid, signal);
};
childProcess.spawnSync = function (command, args, options) {
  if (command !== "/usr/bin/osascript") return originalSpawnSync(command, args, options);
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ command, args }));
  return { status: 0, signal: null, error: null, stdout: "0:1752496496:1000000\\n", stderr: "" };
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );
  const processModule = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "process.mjs")).href;
  const result = run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { probeProcess } from ${JSON.stringify(processModule)}; process.stdout.write(JSON.stringify(probeProcess(4242)));`
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim()
      }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { liveness: "alive", startIdentity: null });
  const observedProbe = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.equal(observedProbe.command, "/usr/bin/osascript");
  assert.match(observedProbe.args[3], /proc_pidinfo/);
});

test("status probes worker leases outside the state lock", { skip: process.platform !== "linux" }, (t) => {
  const workspace = makeTempDir();
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {}
    }
  });
  const lease = readWorkerLease(sleeper.pid);
  const job = {
    id: "task-probe-outside-lock",
    kind: "task",
    jobClass: "task",
    status: "running",
    pid: sleeper.pid,
    workerLease: { ...lease, startIdentity: `${lease.startIdentity}:stale` }
  };
  const { stateDir } = writeTrackedJobFixture(workspace, job);
  const marker = path.join(workspace, "probe-held-lock");
  const preload = path.join(workspace, "probe-lock.cjs");
  fs.writeFileSync(
    preload,
    `const fs = require("node:fs");
const originalRead = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  if (String(file) === "/proc/${sleeper.pid}/stat" && fs.existsSync(${JSON.stringify(path.join(stateDir, ".state.lock"))})) {
    fs.writeFileSync(${JSON.stringify(marker)}, "locked");
  }
  return originalRead.call(this, file, ...args);
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", job.id, "--wait", "--timeout-ms", "0", "--json"], {
    cwd: workspace,
    env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).job.status, "failed");
  assert.equal(fs.existsSync(marker), false);
});

test("status reconciles an identity-owned terminal job before dead-worker fallback", { skip: process.platform !== "linux" }, () => {
  const workspace = makeTempDir();
  const workerLease = { pid: 2147483647, startIdentity: "linux:dead" };
  const job = {
    id: "task-terminal-rename-gap",
    kind: "task",
    jobClass: "task",
    status: "running",
    pid: workerLease.pid,
    workerLease
  };
  const completedAt = "2026-07-14T12:00:00.000Z";
  const { stateDir, jobFile } = writeTrackedJobFixture(workspace, job, {
    ...job,
    status: "completed",
    phase: "done",
    pid: null,
    ownerPid: workerLease.pid,
    ownerLease: workerLease,
    completedAt,
    result: { rawOutput: "finished" },
    rendered: "finished\n"
  });

  const result = run("node", [SCRIPT, "status", job.id, "--wait", "--timeout-ms", "0", "--json"], {
    cwd: workspace
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).job.status, "completed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0].status, "completed");
  assert.deepEqual(JSON.parse(fs.readFileSync(jobFile, "utf8")).result, { rawOutput: "finished" });
});

test("status expires a lease-less queue only after its launcher exits", { skip: process.platform !== "linux" }, (t) => {
  const workspace = makeTempDir();
  const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  launcher.unref();
  t.after(() => {
    try {
      process.kill(-launcher.pid, "SIGTERM");
    } catch {
      try {
        process.kill(launcher.pid, "SIGTERM");
      } catch {}
    }
  });
  const job = {
    id: "task-launcher-lease",
    kind: "task",
    jobClass: "task",
    status: "queued",
    pid: null,
    launcherLease: readWorkerLease(launcher.pid)
  };
  const { stateDir, jobFile } = writeTrackedJobFixture(workspace, job);

  const live = run("node", [SCRIPT, "status", job.id, "--wait", "--timeout-ms", "0", "--json"], { cwd: workspace });
  assert.equal(live.status, 0, live.stderr);
  assert.equal(JSON.parse(live.stdout).job.status, "queued");

  const orphan = { ...job, launcherLease: { pid: 2147483647, startIdentity: "linux:dead" } };
  fs.writeFileSync(jobFile, JSON.stringify(orphan), "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [orphan] })}\n`,
    "utf8"
  );
  const dead = run("node", [SCRIPT, "status", job.id, "--wait", "--timeout-ms", "0", "--json"], { cwd: workspace });
  assert.equal(dead.status, 0, dead.stderr);
  assert.equal(JSON.parse(dead.stdout).job.status, "failed");
});

test("status validates bounded finite wait values and treats zero as no wait", { skip: process.platform !== "linux" }, () => {
  const workspace = makeTempDir();
  const job = { id: "task-wait-values", kind: "task", jobClass: "task", status: "running", pid: null };
  writeTrackedJobFixture(workspace, job);

  const immediate = run("node", [SCRIPT, "status", job.id, "--wait", "--timeout-ms", "0", "--json"], {
    cwd: workspace
  });
  assert.equal(immediate.status, 0, immediate.stderr);
  assert.equal(JSON.parse(immediate.stdout).timeoutMs, 0);
  assert.equal(JSON.parse(immediate.stdout).waitTimedOut, true);

  for (const args of [
    ["--timeout-ms", "NaN"],
    ["--timeout-ms", "Infinity"],
    ["--timeout-ms", "3600001"],
    ["--poll-interval-ms", "Infinity"]
  ]) {
    const invalid = run("node", [SCRIPT, "status", job.id, "--wait", ...args, "--json"], { cwd: workspace });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /must be a finite number from 0 through 3600000/);
  }
});

test("result returns the stored output for the latest finished job by default", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          codex: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n"
  );
});

test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_current",
        result: {
          codex: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_other",
        result: {
          codex: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            createdAt: "2026-03-18T15:10:00.000Z",
            updatedAt: "2026-03-18T15:11:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Current session output.\n\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n"
  );
});

test("result for a finished write-capable task returns the raw Codex final response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const { child: sleeper, cancelControl } = await spawnCancellableFixture(workspace);
  const workerLease = readWorkerLease(sleeper.pid);

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        pid: sleeper.pid,
        workerLease,
        cancelControl,
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            workerLease,
            cancelControl,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancel does not signal a reused worker pid", (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const jobId = "task-reused-pid";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const actualLease = readWorkerLease(sleeper.pid);
  const job = {
    id: jobId,
    status: "running",
    phase: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: sleeper.pid,
    workerLease: { pid: sleeper.pid, startIdentity: `${actualLease.startIdentity}:stale` },
    logFile
  };
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(logFile, "active\n", "utf8");
  fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "cancelled");
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0].status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "cancelled");
});

test("cancel never signals through a check-then-kill pid race", { skip: process.platform !== "linux" }, (t) => {
  const workspace = makeTempDir();
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {}
    }
  });
  const marker = path.join(workspace, "pid-signal-attempted");
  const preload = path.join(workspace, "reject-pid-signal.cjs");
  fs.writeFileSync(
    preload,
    `const fs = require("node:fs");
const originalKill = process.kill.bind(process);
process.kill = function (pid, signal) {
  if (Math.abs(pid) === ${sleeper.pid} && signal !== 0) {
    fs.writeFileSync(${JSON.stringify(marker)}, String(signal));
    const error = new Error("simulated pid reuse before signal");
    error.code = "EPERM";
    throw error;
  }
  return originalKill(pid, signal);
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );
  const job = {
    id: "task-no-check-then-kill",
    kind: "task",
    jobClass: "task",
    status: "running",
    pid: sleeper.pid,
    workerLease: readWorkerLease(sleeper.pid)
  };
  writeTrackedJobFixture(workspace, job);

  const result = run("node", [SCRIPT, "cancel", job.id, "--json"], {
    cwd: workspace,
    env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, "terminating");
  assert.equal(fs.existsSync(marker), false);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
});

test("cancel retains a live worker until a retry confirms it exited", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  const preload = path.join(makeTempDir(), "live-process-mock.cjs");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  sleeper.unref();
  const livePid = sleeper.pid;
  const workerLease = readWorkerLease(livePid);
  async function stopSleeper() {
    if (sleeper.exitCode !== null || sleeper.signalCode !== null) {
      return;
    }
    sleeper.ref();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        sleeper.unref();
        reject(new Error(`Timed out stopping fixture process ${livePid}.`));
      }, 5000);
      sleeper.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      try {
        process.kill(-livePid, "SIGKILL");
      } catch {
        try {
          process.kill(livePid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") {
            clearTimeout(timeout);
            sleeper.unref();
            reject(error);
          }
        }
      }
    });
  }
  t.after(stopSleeper);

  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    preload,
    `const childProcess = require("node:child_process");
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  if (String(command).toLowerCase().includes("taskkill") && args.includes(String(${livePid}))) {
    return { status: 1, signal: null, stdout: "", stderr: "Access denied", error: null };
  }
  return originalSpawnSync(command, args, options);
};
const originalKill = process.kill.bind(process);
process.kill = function (pid, signal) {
  if (Math.abs(pid) === ${livePid} && signal !== 0) {
    const error = new Error("Operation not permitted");
    error.code = "EPERM";
    throw error;
  }
  return originalKill(pid, signal);
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );

  const jobId = "task-live-retry";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const job = {
    id: jobId,
    status: "running",
    phase: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: livePid,
    workerLease,
    logFile
  };
  fs.writeFileSync(logFile, "active\n", "utf8");
  fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] })}\n`,
    "utf8"
  );

  const blocked = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim()
    }
  });
  assert.equal(blocked.status, 1);
  assert.equal(JSON.parse(blocked.stdout).status, "terminating");

  const terminating = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0];
  assert.equal(terminating.status, "terminating");
  assert.equal(terminating.phase, "cancelling");
  assert.equal(terminating.pid, livePid);
  assert.match(terminating.errorMessage, /could not confirm process|timed out while waiting/);
  assert.equal(Object.hasOwn(terminating, "threadArchived"), false);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "terminating");
  assert.equal(fs.existsSync(logFile), true);

  await stopSleeper();

  const retry = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: workspace });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).status, "cancelled");
  const cancelled = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0];
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "cancelled");
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "queued",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
});

test("locked cancellation blocks stale queued and running task starts", async () => {
  for (const status of ["queued", "running"]) {
    const workspace = makeTempDir();
    const stateDir = resolveStateDir(workspace);
    const jobsDir = path.join(stateDir, "jobs");
    const jobId = `task-cancel-race-${status}`;
    const logFile = path.join(jobsDir, `${jobId}.log`);
    const job = {
      id: jobId,
      kind: "task",
      jobClass: "task",
      status,
      phase: status,
      pid: null,
      sessionId: "sess-other",
      logFile
    };
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(logFile, "active\n", "utf8");
    fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify(job), "utf8");
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] })}\n`,
      "utf8"
    );

    const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], {
      cwd: workspace,
      env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" }
    });
    assert.equal(cancel.status, status === "queued" ? 0 : 1, cancel.stderr);
    let runnerCalls = 0;
    const result = await runTrackedJob(
      { ...job, status: "running", pid: process.pid, workspaceRoot: workspace },
      async () => {
        runnerCalls += 1;
      },
      { logFile, preclaimedPid: process.pid }
    );
    assert.equal(result, null);
    assert.equal(runnerCalls, 0);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const expectedStatus = status === "queued" ? "cancelled" : "terminating";
    assert.equal(state.jobs[0].status, expectedStatus);
    assert.equal(state.jobs[0].pid, null);
    const storedJob = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), "utf8"));
    assert.equal(storedJob.status, expectedStatus);
  }
});

test("cancel bounds an unresponsive turn interrupt before terminating the worker", (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  const preload = path.join(makeTempDir(), "hanging-turn-interrupt.cjs");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    preload,
    `const { EventEmitter } = require("node:events");
const workerThreads = require("node:worker_threads");
workerThreads.Worker = class extends EventEmitter {
  terminate() {
    return Promise.resolve(1);
  }
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );
  const jobId = "task-hanging-interrupt";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const job = {
    id: jobId,
    status: "running",
    phase: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: sleeper.pid,
    workerLease: readWorkerLease(sleeper.pid),
    threadId: "thr_hanging_interrupt",
    turnId: "turn_hanging_interrupt",
    logFile
  };
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(logFile, "active\n", "utf8");
  fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] })}\n`,
    "utf8"
  );

  const startedAt = Date.now();
  const result = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim()
    }
  });
  assert.equal(result.status, 1);
  assert.ok(Date.now() - startedAt < 5000);
  assert.equal(JSON.parse(result.stdout).status, "terminating");
  assert.match(fs.readFileSync(logFile, "utf8"), /timed out after 1000ms/);
});

test("completed workers destroy idle cancellation sockets", { skip: process.platform !== "linux", timeout: 10000 }, async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "finish while a client is idle"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const stateFile = path.join(resolveStateDir(repo), "state.json");
  const runningJob = await waitFor(() => {
    const job = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.cancelControl ? job : null;
  }, { timeoutMs: 5000, intervalMs: 10 });
  t.after(() => {
    try {
      terminateProcessTree(runningJob.workerLease.pid);
    } catch {
      // Ignore an already completed worker.
    }
  });

  const socket = net.createConnection(runningJob.cancelControl.endpoint);
  socket.on("error", () => {});
  await new Promise((resolve) => socket.once("connect", resolve));
  await waitFor(() => {
    const job = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "completed";
  }, { timeoutMs: 5000, intervalMs: 10 });
  await waitFor(() => socket.destroyed, { timeoutMs: 1000, intervalMs: 10 });
  assert.equal(fs.existsSync(runningJob.cancelControl.endpoint), false);
});

test("cancellation control is private, bounded, and terminates the worker tree", { skip: process.platform !== "linux", timeout: 20000 }, async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  t.after(() => {
    try {
      terminateProcessTree(runningJob.workerLease.pid);
    } catch {
      // Ignore a worker already stopped by cancellation.
    }
  });
  assert.equal(runningJob.cancelControl.endpoint.includes(runningJob.cancelControl.token), false);
  for (const artifact of [
    runningJob.cancelControl.endpoint,
    path.join(stateDir, "state.json"),
    path.join(stateDir, "jobs", `${jobId}.json`)
  ]) {
    assert.equal(fs.statSync(artifact).mode & 0o077, 0, artifact);
  }

  const idleSocket = net.createConnection(runningJob.cancelControl.endpoint);
  const partialSocket = net.createConnection(runningJob.cancelControl.endpoint);
  idleSocket.on("error", () => {});
  partialSocket.on("error", () => {});
  await Promise.all([
    new Promise((resolve) => idleSocket.once("connect", resolve)),
    new Promise((resolve) => partialSocket.once("connect", resolve))
  ]);
  partialSocket.write(runningJob.cancelControl.token.slice(0, 1));
  await Promise.all([
    waitFor(() => idleSocket.destroyed, { timeoutMs: 2500, intervalMs: 10 }),
    waitFor(() => partialSocket.destroyed, { timeoutMs: 2500, intervalMs: 10 })
  ]);

  const oversizedSocket = net.createConnection(runningJob.cancelControl.endpoint);
  let oversizedResponse = "";
  oversizedSocket.setEncoding("utf8");
  oversizedSocket.on("data", (chunk) => {
    oversizedResponse += chunk;
  });
  oversizedSocket.on("error", () => {});
  await new Promise((resolve) => oversizedSocket.once("connect", resolve));
  oversizedSocket.end(`${runningJob.cancelControl.token}x`);
  await waitFor(() => oversizedSocket.destroyed, { timeoutMs: 1000, intervalMs: 10 });
  assert.equal(oversizedResponse, "denied");

  const descendants = await waitFor(() => {
    const children = fs
      .readFileSync(`/proc/${runningJob.workerLease.pid}/task/${runningJob.workerLease.pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    return children.length > 0 ? children : null;
  }, { timeoutMs: 5000, intervalMs: 10 });

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.threadArchived, true);
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  if (cancelPayload.turnInterrupted) {
    await waitFor(() => {
      const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
      return fakeState.lastInterrupt ?? null;
    });

    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.deepEqual(fakeState.lastInterrupt, {
      threadId: runningJob.threadId,
      turnId: runningJob.turnId
    });
  }
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.threadOperations, [{ method: "thread/archive", threadId: runningJob.threadId }]);
  assert.ok(
    fakeState.calls.findIndex((call) => call.method === "turn/interrupt") <
      fakeState.calls.findIndex((call) => call.method === "thread/archive")
  );
  await waitFor(
    () =>
      descendants.every((pid) => {
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
          return stat.slice(stat.lastIndexOf(")") + 1).trimStart().startsWith("Z ");
        } catch (error) {
          return error?.code === "ENOENT";
        }
      }),
    { timeoutMs: 5000, intervalMs: 25 }
  );

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("session end preserves active and finished task lineage", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  const activeLog = path.join(jobsDir, "task-active.log");
  const finishedLog = path.join(jobsDir, "task-finished.log");
  const reviewLog = path.join(jobsDir, "review-finished.log");
  const activeFile = path.join(jobsDir, "task-active.json");
  const finishedFile = path.join(jobsDir, "task-finished.json");
  const reviewFile = path.join(jobsDir, "review-finished.json");
  fs.writeFileSync(activeLog, "active\n", "utf8");
  fs.writeFileSync(finishedLog, "finished\n", "utf8");
  fs.writeFileSync(reviewLog, "review\n", "utf8");
  fs.writeFileSync(activeFile, JSON.stringify({ id: "task-active", result: null }), "utf8");
  fs.writeFileSync(finishedFile, JSON.stringify({ id: "task-finished", result: { rawOutput: "done" } }), "utf8");
  fs.writeFileSync(reviewFile, JSON.stringify({ id: "review-finished", result: { rawOutput: "reviewed" } }), "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "task-active",
          kind: "task",
          jobClass: "task",
          status: "running",
          sessionId: "sess-current",
          pid: sleeper.pid,
          logFile: activeLog,
          updatedAt: "2026-07-14T12:00:02.000Z"
        },
        {
          id: "task-finished",
          kind: "task",
          jobClass: "task",
          status: "completed",
          sessionId: "sess-current",
          logFile: finishedLog,
          updatedAt: "2026-07-14T12:00:01.000Z"
        },
        {
          id: "review-finished",
          kind: "review",
          jobClass: "review",
          status: "completed",
          sessionId: "sess-current",
          logFile: reviewLog,
          updatedAt: "2026-07-14T12:00:00.000Z"
        }
      ]
    }, null, 2)}\n`,
    "utf8"
  );

  try {
    const result = run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env: {
        ...process.env,
        CODEX_COMPANION_SESSION_ID: "sess-current"
      },
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: "sess-current",
        cwd: repo
      })
    });

    assert.equal(result.status, 0, result.stderr);
    process.kill(sleeper.pid, 0);
    assert.equal(fs.existsSync(activeFile), true);
    assert.equal(fs.existsSync(finishedFile), true);
    assert.equal(fs.existsSync(activeLog), true);
    assert.equal(fs.existsSync(finishedLog), true);
    assert.equal(fs.existsSync(reviewFile), false);
    assert.equal(fs.existsSync(reviewLog), false);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    assert.deepEqual(state.jobs.map((job) => job.id), ["task-active", "task-finished"]);
  } finally {
    try {
      process.kill(sleeper.pid);
    } catch {
      // Ignore cleanup if the process already exited.
    }
  }
});

test("session end prevents a live review worker from recreating removed state", async (t) => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  const stateFile = path.join(stateDir, "state.json");
  const jobFile = path.join(jobsDir, "review-live.json");
  const logFile = path.join(jobsDir, "review-live.log");
  const readyFile = path.join(repo, "worker-ready");
  const resurrectedFile = path.join(repo, "worker-resurrected");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(jobFile, JSON.stringify({ id: "review-live" }), "utf8");
  fs.writeFileSync(logFile, "running\n", "utf8");

  const worker = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const jobFile = ${JSON.stringify(jobFile)};
const logFile = ${JSON.stringify(logFile)};
const readyFile = ${JSON.stringify(readyFile)};
const resurrectedFile = ${JSON.stringify(resurrectedFile)};
const delay = new Int32Array(new SharedArrayBuffer(4));
let snapshot = null;
for (;;) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === "review-live");
    if (job) {
      snapshot = job;
      if (!fs.existsSync(readyFile)) fs.writeFileSync(readyFile, "ready");
    } else if (snapshot) {
      state.jobs.unshift(snapshot);
      fs.writeFileSync(stateFile, JSON.stringify(state));
      fs.writeFileSync(jobFile, JSON.stringify(snapshot));
      fs.writeFileSync(logFile, "resurrected\\n");
      fs.writeFileSync(resurrectedFile, "resurrected");
      process.exit(0);
    }
  } catch {}
  Atomics.wait(delay, 0, 0, 2);
}`
    ],
    { cwd: repo, detached: true, stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
  );
  let workerError = "";
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk) => {
    workerError += chunk;
  });
  worker.unref();
  const workerLease = readWorkerLease(worker.pid);
  t.after(() => {
    try {
      process.kill(worker.pid);
    } catch {
      // Ignore a worker already stopped by SessionEnd.
    }
  });

  const taskFile = path.join(jobsDir, "task-kept.json");
  const taskLog = path.join(jobsDir, "task-kept.log");
  fs.writeFileSync(taskFile, JSON.stringify({ id: "task-kept", result: { rawOutput: "done" } }), "utf8");
  fs.writeFileSync(taskLog, "done\n", "utf8");
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "review-live",
          kind: "review",
          jobClass: "review",
          status: "running",
          sessionId: "sess-current",
          pid: worker.pid,
          workerLease,
          logFile
        },
        {
          id: "task-kept",
          kind: "task",
          jobClass: "task",
          status: "completed",
          sessionId: "sess-current",
          logFile: taskLog
        }
      ]
    })}\n`,
    "utf8"
  );
  await Promise.race([
    waitFor(() => fs.existsSync(readyFile)),
    new Promise((_, reject) => {
      worker.once("exit", (code) => reject(new Error(`Review worker exited ${code}: ${workerError}`)));
      worker.once("error", reject);
    })
  ]);

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-current", cwd: repo })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(resurrectedFile), false);
  assert.equal(fs.existsSync(jobFile), false);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(fs.existsSync(taskFile), true);
  assert.equal(fs.existsSync(taskLog), true);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(state.jobs.map((job) => job.id), ["task-kept"]);
});

test("session end retains a live job when termination cannot be confirmed", (t) => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  const preload = path.join(makeTempDir(), "live-process-mock.cjs");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  sleeper.unref();
  const livePid = sleeper.pid;
  t.after(() => {
    try {
      process.kill(-livePid, "SIGTERM");
    } catch {
      try {
        process.kill(livePid, "SIGTERM");
      } catch {
        // Ignore a process already stopped during cleanup.
      }
    }
  });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    preload,
    `const childProcess = require("node:child_process");
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  if (String(command).toLowerCase().includes("taskkill") && args.includes(String(${livePid}))) {
    return { status: 1, signal: null, stdout: "", stderr: "Access denied", error: null };
  }
  return originalSpawnSync(command, args, options);
};
const originalKill = process.kill.bind(process);
process.kill = function (pid, signal) {
  if (Math.abs(pid) === ${livePid} && signal !== 0) {
    const error = new Error("Operation not permitted");
    error.code = "EPERM";
    throw error;
  }
  return originalKill(pid, signal);
};
require("node:module").syncBuiltinESMExports();
`,
    "utf8"
  );

  const records = [
    { id: "review-live", status: "running", pid: livePid, workerLease: readWorkerLease(livePid) },
    { id: "review-completed", status: "completed" },
    { id: "review-queued", status: "queued", pid: null },
    { id: "task-kept", kind: "task", jobClass: "task", status: "completed" }
  ].map((job) => ({
    kind: "review",
    jobClass: "review",
    sessionId: "sess-current",
    ...job,
    logFile: path.join(jobsDir, `${job.id}.log`)
  }));
  for (const job of records) {
    fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), JSON.stringify(job), "utf8");
    fs.writeFileSync(job.logFile, `${job.id}\n`, "utf8");
  }
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: records })}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim()
    },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-current", cwd: repo })
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const liveJob = state.jobs.find((job) => job.id === "review-live");
  assert.equal(liveJob.status, "terminating");
  assert.equal(liveJob.phase, "terminating");
  assert.equal(liveJob.pid, livePid);
  assert.deepEqual(state.jobs.map((job) => job.id).sort(), ["review-live", "task-kept"]);
  assert.equal(fs.existsSync(path.join(jobsDir, "review-live.json")), true);
  assert.equal(fs.existsSync(path.join(jobsDir, "review-live.log")), true);
  assert.equal(fs.existsSync(path.join(jobsDir, "review-completed.json")), false);
  assert.equal(fs.existsSync(path.join(jobsDir, "review-queued.json")), false);
  assert.equal(fs.existsSync(path.join(jobsDir, "task-kept.json")), true);
});

test("session end fully cleans up jobs for the ending session", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-completed",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-running",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-current",
            pid: sleeper.pid,
            workerLease: readWorkerLease(sleeper.pid),
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(otherJobFile)).sort(),
    [path.basename(otherJobFile), path.basename(otherSessionLog)].sort()
  );

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs.map((job) => job.id), ["review-other"]);
  const otherJob = state.jobs[0];
  assert.equal(otherJob.logFile, otherSessionLog);
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/codex:status/i);
  assert.match(blocked.stderr, /\/codex:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/codex:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("commands lazily start and reuse one shared app-server after first use", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup reuses an existing shared app-server without starting another one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("status reports shared session runtime when a lazy broker is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
});

test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  saveBrokerSession(targetWorkspace, {
    endpoint: "unix:/tmp/fake-broker.sock"
  });

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, "unix:/tmp/fake-broker.sock");
});
