---
name: codex-orchestrator
description: Use when a user asks Fable to use GPT, Codex, or codex-plugin-cc to research, review, diagnose, or implement work. Fable remains the orchestrator and delegates bounded work to Codex.
user-invocable: false
allowed-tools: Agent
---

# Codex orchestration

Fable owns repository research, planning, decomposition, sequencing, route selection, verification, retry decisions, and the final response. Fable chooses routing, not the forwarding agent. Delegate each bounded unit of work directly with:

```
Agent(subagent_type: "codex:codex-rescue", prompt: "--wait --fresh --write --route implementation ...")
```

For explicit research, diagnosis, or review without edits, omit `--write`:

```
Agent(subagent_type: "codex:codex-rescue", prompt: "--wait --fresh --route research ...")
```

Do not invoke a skill, command, or recursive delegation path. Do not delegate the orchestration role.

Use `--fresh` for every independent bounded unit. After inspecting its changes and running relevant checks, use `--wait --resume` only for a dependent follow-up to that same unit:

```
Agent(subagent_type: "codex:codex-rescue", prompt: "--wait --resume <observed failure and requested delta>")
```

A resumed prompt contains only the observed failure and requested delta. Do not repeat route, model, or effort on resume unless the user changes them. Treat empty Agent output as a delegation failure. Report it and direct the user to `/codex:setup`. Report explicit nonempty failures. Do not implement a substitute.

Use write mode for implementation. Use read-only behavior when the user explicitly asks for research, diagnosis, or review without edits. Choose the narrowest configured route and append `--route <name>` to each fresh prompt: `mechanical` for simple edits, `research` for investigation, `implementation` for ordinary code changes, `hard` for difficult fixes, `architecture` for design decisions, and `parallel` for independent units. Preserve an explicit `--route` unchanged. Append any explicit `--model <model>` and `--effort <level>` restrictions unchanged. Workspace route overrides apply to the chosen route. Explicit model and effort restrictions override that route independently. Generic references to GPT or Codex request delegation, not a literal model override.

After every handoff, inspect the changes and run relevant checks. Resume with the observed failures until the bounded work is complete or the user needs to decide scope.
