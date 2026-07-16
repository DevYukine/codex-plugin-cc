---
name: codex-cli-runtime
description: Internal compatibility contract for calling the codex-companion runtime from the codex-rescue agent
user-invocable: false
---

# Codex Runtime

Use this skill only inside the compatibility `codex:codex-rescue` agent. Primary team and rescue flows call the companion directly. The agent's only job is to invoke `task` once and return that stdout unchanged.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --wait --timeout-ms 0 <selected-controls> <shell-quoted-task>`

Execution rules:

- Use exactly one `task` invocation per rescue handoff.
- Always call `task --wait --timeout-ms 0` once in a quick foreground `Bash` and return its durable job handoff stdout unchanged.
- Strip incoming `--background` and `--wait`. The zero-time wait immediately returns a durable `waitTimedOut` handoff after enqueueing fresh or finished-resume work. Against an active task, `--resume` attaches idempotently and does not enqueue another turn.
- Do not set `run_in_background: true`, wait for completion, or claim that the agent auto-wakes.
- Dynamic task text and dynamic control values must each be one literal argv item quoted for the active shell. Preserve the exact text. Never interpolate raw dynamic text or use `eval`, command substitution, redirection, or executable task text.
- In headless `claude -p`, require explicit `--background --fresh` or `--background --resume`. If neither `--fresh` nor `--resume` is supplied, stop with that instruction.
- Write runs use `features.multi_agent=false`. The delegated model is one senior developer and must not create internal subagents.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `codex:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fixes.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt. That prompt drafting is the only Claude-side work allowed.

Command selection:

- Preserve `--route`, `--model`, and `--effort` for host selection. Map `spark` to `--model gpt-5.3-codex-spark`.
- Strip forwarded `--background` and `--wait`; the compatibility command supplies `--wait --timeout-ms 0`.
- If the forwarded request includes `--route`, pass it through to `task`.
- Pass `--resume` or `--fresh` to `task` and strip those controls from task text.
- `task --wait --timeout-ms 0 --resume <delta>` resumes a finished current-session thread or attaches idempotently to the active task, then returns a durable handoff.
- `--fresh` starts a new task even when the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
- Built-in routes are: `mechanical` (`gpt-5.6-luna`, `low`), `research` (`gpt-5.6-terra`, `medium`), `implementation` (`gpt-5.6-sol`, `high`), `hard` (`gpt-5.6-sol`, `xhigh`), `architecture` (`gpt-5.6-sol`, `max`), and `parallel` (`gpt-5.6-sol`, `max`).
- The host applies workspace route overrides from `/codex:setup` field by field. Explicit `--model` and `--effort` override the selected route independently. With no `--route`, `--model`, or `--effort`, preserve the current null model/effort behavior. For a fresh run, the host may infer the narrowest matching route. A resumed run keeps its existing model and effort unless `--route`, `--model`, or `--effort` is explicit.
- Default to `--write` unless the user explicitly requests read-only review, diagnosis, or research.

Safety rules:

- Preserve the task text apart from execution and routing flags.
- Never invoke a package manager or install dependencies.
- Do not inspect the repository, read files, grep, monitor, summarize, cancel, or do follow-up work.
- If the Bash call fails or Codex cannot be invoked, return nothing.
