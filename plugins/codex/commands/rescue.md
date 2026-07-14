---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--route <mechanical|research|implementation|hard|architecture|parallel>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`), forwarding the selected request as the prompt. Build it from the raw user request below plus only the execution and routing flags described here.
`codex:codex-rescue` is a subagent, not a skill — do not call `Skill(codex:codex-rescue)` (no such skill) or `Skill(codex:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `codex:codex-rescue` subagent in the background.
- If the request includes `--wait`, run the `codex:codex-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` is an execution flag for Claude Code. Do not forward it to `task`, and do not treat it as part of the natural-language task text.
- `--wait` is an execution flag for Claude Code and runtime control for `task`. Preserve `--wait` in the forwarded request, but do not treat it as part of the natural-language task text.
- `--route`, `--model`, and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Routing:

- Built-in routes are: `mechanical` (`gpt-5.6-luna`, `low`), `research` (`gpt-5.6-terra`, `medium`), `implementation` (`gpt-5.6-sol`, `high`), `hard` (`gpt-5.6-sol`, `xhigh`), `architecture` (`gpt-5.6-sol`, `max`), and `parallel` (`gpt-5.6-sol`, `max`).
- Workspace route overrides configured by `/codex:setup` replace built-in model and effort values field by field.
- Explicit `--model` and `--effort` override the selected route independently.
- For a fresh request with no `--route`, `--model`, or `--effort`, choose the narrowest built-in route when appropriate and append `--route <name>` before delegating. If no built-in route is appropriate, preserve the current null model/effort behavior.
- On resume, do not infer a route or replace existing settings. A resumed run keeps its existing model and effort unless `--route`, `--model`, or `--effort` is explicit.

Operating rules:

- Fable makes exactly one `Agent(subagent_type: "codex:codex-rescue", ...)` forward per delegation. Do not start another Agent to wait, monitor, poll, or repeat the request.
- An active result with `waitTimedOut: true` is a durable handoff, not a claim that the wrapper is still waiting. Return it verbatim and preserve its `jobId`.
- A later explicit or user-driven `--wait --resume <delta>` attaches to that same active task. Repeated attaches are idempotent and start no new implementation turn while it is active. `--fresh` explicitly starts a new task.
- Delegated write runs set `features.multi_agent=false`. Fable remains the manager and the delegated model is a single senior developer, not an internal-subagent coordinator.
- If a completed delegated result says an install was blocked by registry or network policy, Fable may perform the exact required install host-side using the workspace's existing package manager, proxy, and registry configuration. Then make one `--wait --resume` delegation with the requested delta.
- Select the package manager from the workspace's `packageManager` field or lockfile. Run only one matching `npm install`, `npm ci`, `pnpm install`, `pnpm add`, `yarn install`, `yarn add`, `bun install`, or `bun add` command, with its working directory at the current workspace root.
- Before asking for approval, validate every argument. Allow only registry dependency specifiers named by the completed result, dependency-class or lockfile flags required for that install, and workspace selectors whose targets are declared by the local workspace manifest. Reject any unknown argument, shell operator, command substitution, redirection, environment assignment, global or working-directory flag, script or executable subcommand, registry, proxy, or config override, URL, VCS or file specifier, credential, or path outside the current workspace.
- Use `AskUserQuestion` to show the exact command and workspace root. Run it only after the user explicitly approves it. Package-manager Bash permissions are intentionally absent from `allowed-tools`; approve only that invocation and do not add a persistent permission.
- If validation fails or the user declines, do not install or resume. Report the reason. Do not broaden network access, add wildcard allowlists, escalate privileges, or retry an active task.
- After route selection, the subagent is a thin forwarder only. It should use exactly one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...`, forward the selected request unchanged, and return that command's stdout as-is.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize output, or do follow-up work of its own.
- Preserve `--route`, `--model`, and `--effort` for host selection. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.
