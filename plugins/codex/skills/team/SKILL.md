---
name: team
description: Delegate work to Codex when a user asks Fable to use GPT, Codex, the Codex CC plugin, or codex-plugin-cc.
argument-hint: "<task> [--route <name>] [--model <model>] [--effort <level>]"
user-invocable: true
allowed-tools: Agent
---

# Codex team

Fable owns planning, decomposition, architecture, review, judgment, routing, verification, retries, and the final response. Each delegation has exactly one `Agent(subagent_type: "codex:codex-rescue", ...)` forward. Delegate bounded implementation units directly with:

```
Agent(subagent_type: "codex:codex-rescue", prompt: "--wait --fresh --write --route implementation ...")
```

Keep delegation in the foreground with `--wait`. Use `--fresh` for every independent bounded unit. An active `waitTimedOut: true` result is a durable handoff, not a continuing wait. Preserve its `jobId` and do not start another Agent to wait, monitor, poll, or retry it. A later explicit or user-driven `--wait --resume` attaches to the same active task. Repeated attaches are idempotent and start no new implementation turn while active. Use `--wait --resume` only for a dependent follow-up to that same unit:

```
Agent(subagent_type: "codex:codex-rescue", prompt: "--wait --resume <observed failure and requested delta>")
```

Keep a resumed prompt to the observed failure and requested delta. Do not repeat route, model, or effort on resume unless the user changes them. Delegated write runs use `features.multi_agent=false`. Fable remains the manager and the delegated model is a single senior developer, not an internal-subagent coordinator. If a completed delegated result says an install was blocked by registry or network policy, Fable performs the exact required install host-side using the workspace's existing package manager, proxy, and registry configuration, then makes one `--wait --resume` delegation to continue the same thread. Do not broaden network access, add wildcard allowlists, escalate privileges, or retry an active task. Treat empty Agent output as a delegation failure. Report it and direct the user to `/codex:setup`. Report explicit nonempty failures. Do not implement a substitute.

For a fresh task, preserve an explicit `--route` unchanged. Preserve explicit `--model <model>` and `--effort <level>` restrictions unchanged. Workspace route overrides apply to the chosen route. Explicit model and effort restrictions override that route independently. Generic references to GPT or Codex request delegation, not a literal model override.

Choose defaults only when the user did not provide a route:

- Ordinary implementation: `--route implementation` (`gpt-5.6-sol`, `high`) with `--write`.
- Difficult debugging: `--route hard` (`gpt-5.6-sol`, `xhigh`).
- Long or genuinely parallel coding: `--route parallel` (`gpt-5.6-sol`, `max`).
- Everyday non-implementation work and drafts: `--route research` (`gpt-5.6-terra`, `medium`), with `--write` only for requested non-code output.
- Reconnaissance and deterministic bulk or search work: `--route mechanical` (`gpt-5.6-luna`, `low`), read-only unless a bounded mechanical write is requested.

Do not infer an architecture or review delegation in team mode.

Delegated Codex cannot receive Fable host browser or computer tools. When host tools are available, gather the observations and forward the exact evidence to the selected delegated worker using the selected route. Sol is the default for diagnosis and code work, but explicit route, model, and effort overrides still win. When host tools are unavailable, report that limitation. Never claim the delegated worker directly used unavailable tools.

After a completed handoff, inspect the changes and run relevant checks. Do not automatically resume, wait, or retry an active task. Do not invoke a Skill, `/codex:rescue`, or recursive delegation path.
