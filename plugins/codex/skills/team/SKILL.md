---
name: team
description: Delegate work to Codex when a user asks Fable to use GPT, Codex, the Codex CC plugin, or codex-plugin-cc.
argument-hint: "<task> [--route <name>] [--model <model>] [--effort <level>]"
user-invocable: true
allowed-tools: Bash(node:*), Read
---

# Codex team

Fable owns planning, decomposition, architecture, review, judgment, routing, verification, retries, and the final response. Do not route primary team work through `Agent`. Do not invoke a Skill, `/codex:rescue`, or recursive delegation path.

For every fresh bounded unit, Fable directly launches exactly one main-owned background `Bash` waiter:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --wait --timeout-ms 21600000 --poll-interval-ms 2000 --fresh --write --route implementation <shell-quoted-task>`,
  description: "Codex team task",
  run_in_background: true
})
```

Replace `<shell-quoted-task>` and every dynamic control value with one literal argv item quoted for the active shell. Preserve the exact text. Never interpolate raw dynamic text or use `eval`, command substitution, redirection, or executable task text.

Use `--fresh` for every independent bounded unit. Use `--wait --resume` only for a dependent follow-up to that same unit. Preserve an explicit `--route`, `--model`, or `--effort` instead of the example defaults. Add `--write` only when the delegated work may edit files.

For a dependent follow-up to the same unit, launch exactly one new main-owned background `Bash` waiter with the observed failure and requested delta:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --wait --timeout-ms 21600000 --poll-interval-ms 2000 --resume --write <shell-quoted-task>`,
  description: "Codex team follow-up",
  run_in_background: true
})
```

Do not repeat route, model, or effort on resume unless the user changes them. Delegated write runs use `features.multi_agent=false`. Fable remains the manager and the delegated model is a single senior developer, not an internal-subagent coordinator.

The companion watcher checks job state every 2 seconds without model turns and expires after 6 hours. Do not pass `--background` to a waited task. Do not call `TaskOutput`, `BashOutput`, `status`, `result`, or any polling command. The host task notification is the wake-up. In interactive Claude Code, terminal completion automatically re-invokes Fable. Use the notification stdout. If the notification provides an output-file path, use `Read` on that path exactly once and treat its contents as stdout. Repeated attaches are idempotent and start no new implementation turn while active.

If the watcher times out, its active `waitTimedOut: true` result is a durable handoff. Preserve its `jobId`; the detached worker survives the watcher timeout. Do not retry an active task.

In headless `claude -p`, task notifications do not re-invoke Fable, so the waited flow cannot auto-wake. Require explicit `--background --fresh` or `--background --resume`; if neither `--fresh` nor `--resume` is supplied, stop with that instruction. Allow `--background --resume` only for a prior task confirmed terminal through status or result, never for an active task. Make one quick foreground launch and return its durable handoff stdout:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background <selected-controls> <shell-quoted-task>
```

Do not set `run_in_background: true` for the headless launch.

If a completed delegated result says an install was blocked by registry or network policy, Fable performs the exact required install host-side using the workspace's existing package manager, proxy, and registry configuration, then makes one `--wait --resume` delegation to continue the same thread. Do not broaden network access, add wildcard allowlists, escalate privileges, or retry an active task. Treat empty stdout as a delegation failure. Report it and direct the user to `/codex:setup`. Report explicit nonempty failures. Do not implement a substitute.

For a fresh task, preserve an explicit `--route` unchanged. Preserve explicit `--model <model>` and `--effort <level>` restrictions unchanged. Workspace route overrides apply to the chosen route. Explicit model and effort restrictions override that route independently. Generic references to GPT or Codex request delegation, not a literal model override.

Choose defaults only when the user did not provide a route:

- Ordinary implementation: `--route implementation` (`gpt-5.6-sol`, `high`) with `--write`.
- Difficult debugging: `--route hard` (`gpt-5.6-sol`, `xhigh`).
- Long or genuinely parallel coding: `--route parallel` (`gpt-5.6-sol`, `max`).
- Everyday non-implementation work and drafts: `--route research` (`gpt-5.6-terra`, `medium`), with `--write` only for requested non-code output.
- Reconnaissance and deterministic bulk or search work: `--route mechanical` (`gpt-5.6-luna`, `low`), read-only unless a bounded mechanical write is requested.

Do not infer an architecture or review delegation in team mode.

Delegated Codex cannot receive Fable host browser or computer tools. When host tools are available, gather the observations and forward the exact evidence to the selected delegated worker using the selected route. Sol is the default for diagnosis and code work, but explicit route, model, and effort overrides still win. When host tools are unavailable, report that limitation. Never claim the delegated worker directly used unavailable tools.

After a completed handoff, inspect the changes and run relevant checks. Do not automatically resume or retry an active task.
