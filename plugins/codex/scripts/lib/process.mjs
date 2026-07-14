import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const DARWIN_PROCESS_START_SCRIPT = `
ObjC.import("stdlib");
ObjC.bindFunction("dlopen", ["void *", ["string", "int"]]);
ObjC.bindFunction("dlsym", ["void *", ["void *", "string"]]);
ObjC.bindFunction("dlclose", ["int", ["void *"]]);
ObjC.bindFunction("malloc", ["void *", ["int"]]);
ObjC.bindFunction("free", ["void", ["void *"]]);

function run(argv) {
  // Constants follow the public libproc.h proc_bsdinfo ABI.
  const PROC_PIDTBSDINFO = 3;
  const PROC_BSDINFO_SIZE = 136;
  const PID_OFFSET = 12;
  const START_SECONDS_OFFSET = 120;
  const START_MICROSECONDS_OFFSET = 128;
  const pid = Number(argv[0]);
  const library = $.dlopen("/usr/lib/libproc.dylib", 10);
  $.dlsym(library, "proc_pidinfo");
  ObjC.bindFunction("proc_pidinfo", ["int", ["int", "int", "Int64", "void *", "int"]]);
  const info = $.malloc(PROC_BSDINFO_SIZE);
  try {
    if ($.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, PROC_BSDINFO_SIZE) !== PROC_BSDINFO_SIZE) return "";
    const bytes = new Uint8Array(PROC_BSDINFO_SIZE);
    for (let index = 0; index < PROC_BSDINFO_SIZE; index += 1) bytes[index] = info[index];
    const view = new DataView(bytes.buffer);
    const secondsLow = view.getUint32(START_SECONDS_OFFSET, true);
    const secondsHigh = view.getUint32(START_SECONDS_OFFSET + 4, true);
    const microseconds = view.getUint32(START_MICROSECONDS_OFFSET, true);
    if (
      view.getUint32(PID_OFFSET, true) !== pid ||
      (secondsHigh === 0 && secondsLow === 0) ||
      view.getUint32(START_MICROSECONDS_OFFSET + 4, true) !== 0 ||
      microseconds >= 1000000
    ) return "";
    return [secondsHigh, secondsLow, microseconds].join(":");
  } finally {
    $.free(info);
    $.dlclose(library);
  }
}
`;

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    timeout: options.timeout,
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function probeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { liveness: "unknown", startIdentity: null };
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    return { liveness: error?.code === "ESRCH" ? "gone" : "unknown", startIdentity: null };
  }

  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const fields = commandEnd === -1 ? [] : stat.slice(commandEnd + 1).trimStart().split(/\s+/);
      if (fields.length < 20) {
        return { liveness: "unknown", startIdentity: null };
      }
      return {
        liveness: fields[0] === "Z" ? "gone" : "alive",
        startIdentity: `linux:${fields[19]}`
      };
    } catch (error) {
      return { liveness: error?.code === "ENOENT" ? "gone" : "unknown", startIdentity: null };
    }
  }

  if (process.platform === "darwin") {
    const result = spawnSync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", DARWIN_PROCESS_START_SCRIPT, String(pid)],
      { encoding: "utf8", timeout: 2000 }
    );
    const start = String(result.stdout ?? "").trim();
    const match = /^(\d+):(\d+):(\d+)$/.exec(start);
    const parts = match?.slice(1).map(Number) ?? [];
    const valid =
      !result.error &&
      result.status === 0 &&
      parts.length === 3 &&
      parts[0] <= 0xffffffff &&
      parts[1] <= 0xffffffff &&
      (parts[0] !== 0 || parts[1] !== 0) &&
      parts[2] < 1000000;
    return { liveness: "alive", startIdentity: valid ? `darwin:${start}` : null };
  }

  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`
      ],
      { encoding: "utf8", timeout: 2000, windowsHide: true }
    );
    const start = String(result.stdout ?? "").trim();
    return {
      liveness: "alive",
      startIdentity: !result.error && result.status === 0 && /^[1-9]\d*$/.test(start) ? `win32:${start}` : null
    };
  }

  return { liveness: "alive", startIdentity: null };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw error;
    }
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
