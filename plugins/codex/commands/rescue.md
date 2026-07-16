---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to Codex
argument-hint: "[--background|--wait] [--resume|--fresh] [--route <mechanical|research|implementation|hard|architecture|parallel>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Read
---

Run the selected rescue request directly through the Codex companion. Do not invoke `Agent`. Do not call `Skill(codex:codex-rescue)` or `Skill(codex:rescue)`.

Raw user request:
$ARGUMENTS

Execution mode:

- Explicit `--background` is launch-only. Use the foreground launch flow below.
- Explicit `--wait` and the default mode use the same main-owned background waiter.
- `--background` and `--wait` are execution controls, not natural-language task text.
- `--route`, `--model`, and `--effort` are runtime-selection flags. Preserve them for `task`, but do not treat them as task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- In headless `claude -p`, never use `AskUserQuestion`. Require explicit `--background --fresh` or `--background --resume`. Allow `--background --resume` only for a prior task confirmed terminal through status or result, never for an active task. If neither combination is supplied, stop and tell the user to rerun with one of them.
- Otherwise, in interactive Claude Code, check for a resumable rescue thread with one quick foreground call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If it reports `available: true`, use `AskUserQuestion` exactly once with these choices:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- For a clear follow-up such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first. Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume`. If the user chooses a new thread, add `--fresh`. If the helper reports `available: false`, do not ask.

Routing:

- Built-in routes are: `mechanical` (`gpt-5.6-luna`, `low`), `research` (`gpt-5.6-terra`, `medium`), `implementation` (`gpt-5.6-sol`, `high`), `hard` (`gpt-5.6-sol`, `xhigh`), `architecture` (`gpt-5.6-sol`, `max`), and `parallel` (`gpt-5.6-sol`, `max`).
- Workspace route overrides configured by `/codex:setup` replace built-in model and effort values field by field.
- Explicit `--model` and `--effort` override the selected route independently. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- For a fresh request with no `--route`, `--model`, or `--effort`, choose the narrowest built-in route when appropriate and append `--route <name>` before delegating. If none fits, preserve the current null model/effort behavior.
- On resume, do not infer a route or replace existing settings. Existing model and effort remain unless the user explicitly changes them.
- Default to `--write` unless the user explicitly asks for read-only review, diagnosis, or research.

Waited/default flow:

- After route selection, Fable directly launches exactly one main-owned background `Bash` command with the selected write, route, model, effort, resume, fresh, and task controls:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --wait --timeout-ms 21600000 --poll-interval-ms 2000 <selected-controls> <shell-quoted-task>`,
  description: "Codex rescue",
  run_in_background: true
})
```

- Do not pass `--background` to this waited task.
- Replace each dynamic control value and `<shell-quoted-task>` with one literal argv item quoted for the active shell. Preserve the exact text. Never interpolate raw dynamic text or use `eval`, command substitution, redirection, or executable task text.
- The local watcher checks job state every 2 seconds without model turns and expires after 6 hours. The detached worker survives a watcher timeout.
- Do not call `TaskOutput`, `BashOutput`, `status`, `result`, or any polling command. The host task notification is the wake-up.
- In interactive Claude Code, terminal completion automatically re-invokes Fable. Use the notification stdout. If it supplies an output-file path, use `Read` on that path exactly once and treat its contents as stdout. Then inspect the changes and run relevant checks before responding.
- In headless `claude -p`, task notifications do not re-invoke Fable, so waited rescue cannot auto-wake. Only the explicit background flow above is allowed.
- An active result with `waitTimedOut: true` is a durable handoff. Preserve its `jobId`; repeated attaches are idempotent and start no new implementation turn while it is active. Do not retry an active task.

Explicit background flow:

- Make exactly one quick foreground `Bash` call to `task --background` with the selected controls:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background <selected-controls> <shell-quoted-task>
```

- Do not set `run_in_background: true` for this launch-only call. Return its durable job handoff stdout as-is. The user may use `/codex:status` or `/codex:result` later.

Operating rules:

- Delegated write runs set `features.multi_agent=false`. Fable remains the manager and the delegated model is a single senior developer, not an internal-subagent coordinator.
- If a completed result says an install was blocked by registry or network policy, Fable may perform the exact required install host-side using the workspace's existing package manager, proxy, and registry configuration. Then make one waited `--resume` delegation with the requested delta.
- Select the package manager from the workspace's `packageManager` field or lockfile. Run only one matching `npm install`, `npm ci`, `pnpm install`, `pnpm add`, `yarn install`, `yarn add`, `bun install`, or `bun add` command, with its working directory at the current workspace root.
- Before asking for approval, validate every argument. Allow only dependency specifiers named by the completed result, required dependency-class or lockfile flags, and declared workspace selectors. Reject any unknown argument, shell operator, command substitution, redirection, environment assignment, global or working-directory flag, executable subcommand, registry, proxy, or config override, URL, VCS or file specifier, credential, or path outside the current workspace.
- Use `AskUserQuestion` to show the exact command and workspace root. Run it only after the user explicitly approves it. Package-manager Bash permissions are intentionally absent from `allowed-tools`; approve only that invocation and do not add a persistent permission.
- If validation fails or the user declines, do not install or resume. Do not broaden network access, add wildcard allowlists, escalate privileges, or retry an active task.
- If the helper reports Codex missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user supplied no task, ask what Codex should investigate or fix.
