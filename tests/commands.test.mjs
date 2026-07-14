import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("team skill keeps Fable in control while delegating bounded Codex work", () => {
  const source = read("skills/team/SKILL.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();

  assert.match(source, /^name:\s*team$/m);
  assert.match(source, /description:.*(?:GPT|Codex|codex-plugin-cc)/i);
  assert.match(source, /^argument-hint:\s*"<task> \[--route <name>\] \[--model <model>\] \[--effort <level>\]"$/m);
  assert.match(source, /^user-invocable:\s*true$/m);
  assert.match(source, /^allowed-tools:\s*Agent$/m);
  assert.doesNotMatch(source, /^context:\s*fork$/m);
  assert.match(source, /Fable owns planning, decomposition, architecture, review, judgment, routing, verification, retries, and the final response/i);
  assert.match(source, /Each delegation has exactly one `Agent\(subagent_type: "codex:codex-rescue", \.\.\.\)` forward/i);
  assert.match(source, /Agent\(subagent_type: "codex:codex-rescue", prompt: "--wait --fresh --write --route implementation/);
  assert.match(source, /Agent\(subagent_type: "codex:codex-rescue", prompt: "--wait --resume <observed failure and requested delta>"\)/);
  assert.doesNotMatch(source, /Skill\(/);
  assert.match(source, /Do not invoke a Skill, `\/codex:rescue`, or recursive delegation path/i);
  assert.match(source, /Use `--fresh` for every independent bounded unit/i);
  assert.match(source, /use `--wait --resume` only for a dependent follow-up to that same unit/i);
  assert.match(source, /active `waitTimedOut: true` result is a durable handoff/i);
  assert.match(source, /Preserve its `jobId`/i);
  assert.match(source, /Repeated attaches are idempotent and start no new implementation turn while active/i);
  assert.match(source, /Delegated write runs use `features\.multi_agent=false`/i);
  assert.match(source, /single senior developer, not an internal-subagent coordinator/i);
  assert.match(source, /install was blocked by registry or network policy/i);
  assert.match(source, /workspace's existing package manager, proxy, and registry configuration/i);
  assert.match(source, /then makes one `--wait --resume` delegation to continue the same thread/i);
  assert.match(source, /Do not broaden network access, add wildcard allowlists, escalate privileges, or retry an active task/i);
  assert.doesNotMatch(source, /monitoring loop/i);
  assert.doesNotMatch(source, /Resume the same unit with observed failures until it is complete/i);
  assert.match(source, /observed failure and requested delta/i);
  assert.match(source, /Do not repeat route, model, or effort on resume unless the user changes them/i);
  assert.match(source, /Treat empty Agent output as a delegation failure\. Report it and direct the user to `\/codex:setup`/i);
  assert.match(source, /do not implement a substitute/i);
  assert.match(source, /Report explicit nonempty failures/i);
  assert.match(source, /implementation.*`--write`/i);
  assert.match(source, /Ordinary implementation: `--route implementation` \(`gpt-5\.6-sol`, `high`\) with `--write`/);
  assert.match(source, /Difficult debugging: `--route hard` \(`gpt-5\.6-sol`, `xhigh`\)/);
  assert.match(source, /Long or genuinely parallel coding: `--route parallel` \(`gpt-5\.6-sol`, `max`\)/);
  assert.match(source, /Everyday non-implementation work and drafts: `--route research` \(`gpt-5\.6-terra`, `medium`\), with `--write` only for requested non-code output/);
  assert.match(source, /Reconnaissance and deterministic bulk or search work: `--route mechanical` \(`gpt-5\.6-luna`, `low`\), read-only unless a bounded mechanical write is requested/);
  assert.match(source, /Do not infer an architecture or review delegation in team mode/i);
  assert.match(source, /Preserve explicit `--model <model>` and `--effort <level>` restrictions unchanged/i);
  assert.match(source, /Preserve an explicit `--route` unchanged/i);
  assert.match(source, /Workspace route overrides apply to the chosen route/i);
  assert.match(source, /Explicit model and effort restrictions override that route independently/i);
  assert.match(source, /Generic references to GPT or Codex.*not a literal model override/i);
  assert.match(source, /After a completed handoff, inspect the changes and run relevant checks/i);
  assert.match(source, /Delegated Codex cannot receive Fable host browser or computer tools/i);
  assert.match(source, /forward the exact evidence to the selected delegated worker using the selected route/i);
  assert.match(source, /Sol is the default for diagnosis and code work, but explicit route, model, and effort overrides still win/i);
  assert.match(source, /When host tools are unavailable, report that limitation/i);
  assert.match(source, /Never claim the delegated worker directly used unavailable tools/i);
  assert.match(readme, /\/codex:team <task>/);
  assert.match(readme, /\/codex:team implement this/);
  assert.match(readme, /\| Sol \| `gpt-5\.6-sol` \/ `high` \| Implementation \|/);
  assert.match(readme, /\| Terra \| `gpt-5\.6-terra` \/ `medium` \| Everyday non-implementation work and drafts \|/);
  assert.match(readme, /\| Luna \| `gpt-5\.6-luna` \/ `low` \| Recon, deterministic bulk work, and background searches \|/);
  assert.match(readme, /Workspace route overrides replace built-in route fields\. Explicit route, model, and effort restrictions then win independently/i);
  assert.match(readme, /forwards observations to the selected delegated worker/i);
  assert.match(readme, /edit access on `--write` runs/i);
  assert.match(readme, /Read-only delegations cannot edit/i);
  assert.equal(commandFiles.includes("team.md"), false);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Codex's output verbatim/i);
  assert.equal(
    rescue.match(/^allowed-tools:\s*(.+)$/m)?.[1],
    "Bash(node:*), AskUserQuestion, Agent"
  );
  assert.doesNotMatch(rescue, /^allowed-tools:.*Bash\((?:npm|pnpm|yarn|bun)\b/m);
  // Regression for #234: `Skill(codex:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose ("Route this
  // request to the `codex:codex-rescue` subagent") while running under
  // `context: fork` — forked general-purpose subagents do not expose the
  // `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "codex:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(codex:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--route <mechanical\|research\|implementation\|hard\|architecture\|parallel>/);
  assert.match(rescue, /--model <model\|spark>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /run the `codex:codex-rescue` subagent in the background/i);
  assert.match(rescue, /forwarding the selected request as the prompt/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Preserve `--wait` in the forwarded request/i);
  assert.doesNotMatch(rescue, /`--wait`[^\n]*Do not forward[^\n]*`task`/i);
  assert.match(rescue, /`--route`, `--model`, and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /Built-in routes are: `mechanical` \(`gpt-5\.6-luna`, `low`\).*`implementation` \(`gpt-5\.6-sol`, `high`\).*`parallel` \(`gpt-5\.6-sol`, `max`\)/i);
  assert.match(rescue, /Workspace route overrides configured by `\/codex:setup` replace built-in model and effort values field by field/i);
  assert.match(rescue, /Explicit `--model` and `--effort` override the selected route independently/i);
  assert.match(rescue, /null model\/effort behavior/i);
  assert.match(rescue, /fresh request with no `--route`, `--model`, or `--effort`, choose the narrowest built-in route when appropriate and append `--route <name>` before delegating/i);
  assert.match(rescue, /On resume, do not infer a route or replace existing settings/i);
  assert.match(rescue, /After route selection.*exactly one `Bash` call.* task .*, forward the selected request unchanged, and return that command's stdout as-is/is);
  assert.match(rescue, /exactly one `Agent\(subagent_type: "codex:codex-rescue", \.\.\.\)` forward per delegation/i);
  assert.match(rescue, /active result with `waitTimedOut: true` is a durable handoff/i);
  assert.match(rescue, /preserve its `jobId`/i);
  assert.match(rescue, /Repeated attaches are idempotent and start no new implementation turn while it is active/i);
  assert.match(rescue, /Delegated write runs set `features\.multi_agent=false`/i);
  assert.match(rescue, /exact required install host-side/i);
  assert.match(rescue, /Select the package manager from the workspace's `packageManager` field or lockfile/i);
  assert.match(rescue, /Run only one matching `npm install`.*`bun add` command/i);
  assert.match(rescue, /working directory at the current workspace root/i);
  assert.match(rescue, /Before asking for approval, validate every argument/i);
  assert.match(rescue, /Reject any unknown argument, shell operator.*path outside the current workspace/i);
  assert.match(rescue, /Use `AskUserQuestion` to show the exact command and workspace root/i);
  assert.match(rescue, /Run it only after the user explicitly approves it/i);
  assert.match(rescue, /Package-manager Bash permissions are intentionally absent from `allowed-tools`/i);
  assert.match(rescue, /approve only that invocation and do not add a persistent permission/i);
  assert.match(rescue, /If validation fails or the user declines, do not install or resume/i);
  assert.doesNotMatch(rescue, /monitoring loop/i);
  assert.match(rescue, /If they ask for `spark`, map it to `gpt-5\.3-codex-spark`/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Codex companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Codex running for a long time, prefer background execution/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /active `waitTimedOut: true` result unchanged, including its `jobId`/i);
  assert.match(agent, /idempotent while active, and starts no new implementation turn/i);
  assert.match(agent, /Write runs use `features\.multi_agent=false`/i);
  assert.match(agent, /^tools:\s*Bash$/m);
  assert.doesNotMatch(agent, /^allowed-tools:/m);
  assert.match(agent, /Never invoke a package manager or install dependencies\. Fable owns any separately approved host-side install/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /^model:\s*inherit$/m);
  assert.match(agent, /Built-in routes are: `mechanical` \(`gpt-5\.6-luna`, `low`\).*`implementation` \(`gpt-5\.6-sol`, `high`\).*`parallel` \(`gpt-5\.6-sol`, `max`\)/i);
  assert.match(agent, /workspace route overrides from `\/codex:setup` field by field/i);
  assert.match(agent, /Explicit `--model` and `--effort` override the selected route independently/i);
  assert.match(agent, /null model\/effort behavior/i);
  assert.match(agent, /fresh run, the host may infer the narrowest matching route/i);
  assert.match(agent, /resumed run keeps its existing model and effort unless `--route`, `--model`, or `--effort` is explicit/i);
  assert.match(agent, /If the user asks for `spark`, map that to `--model gpt-5\.3-codex-spark`/i);
  assert.match(agent, /If the user asks for a concrete model name such as `gpt-5\.4-mini`, pass it through with `--model`/i);
  assert.match(agent, /Return the stdout of the `codex-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Codex cannot be invoked, return nothing/i);
  assert.match(agent, /gpt-5-4-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Codex prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Built-in routes are: `mechanical` \(`gpt-5\.6-luna`, `low`\).*`implementation` \(`gpt-5\.6-sol`, `high`\).*`parallel` \(`gpt-5\.6-sol`, `max`\)/i);
  assert.match(runtimeSkill, /workspace route overrides from `\/codex:setup` field by field/i);
  assert.match(runtimeSkill, /Explicit `--model` and `--effort` override the selected route independently/i);
  assert.match(runtimeSkill, /null model\/effort behavior/i);
  assert.match(runtimeSkill, /fresh run, the host may infer the narrowest matching route/i);
  assert.match(runtimeSkill, /resumed run keeps its existing model and effort unless `--route`, `--model`, or `--effort` is explicit/i);
  assert.match(runtimeSkill, /Map `spark` to `--model gpt-5\.3-codex-spark`/i);
  assert.match(runtimeSkill, /active `waitTimedOut: true` result is a durable handoff/i);
  assert.match(runtimeSkill, /with its `jobId`/i);
  assert.match(runtimeSkill, /task --wait --resume <delta>/i);
  assert.match(runtimeSkill, /idempotent while active/i);
  assert.match(runtimeSkill, /Write runs use `features\.multi_agent=false`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background`, treat it as execution control only/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--wait`, pass it through to `task`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--route`, pass it through to `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Codex cannot be invoked, return nothing/i);
  assert.match(readme, /`codex:codex-rescue` subagent/i);
  assert.match(readme, /\/plugin marketplace add DevYukine\/codex-plugin-cc/);
  assert.match(readme, /\/plugin install codex@openai-codex/);
  assert.match(readme, /\/reload-plugins/);
  assert.match(readme, /\/codex:setup/);
  assert.match(readme, /\| `mechanical` \| `gpt-5\.6-luna` \| `low` \|/);
  assert.match(readme, /\| `parallel` \| `gpt-5\.6-sol` \| `max` \|/);
  assert.match(readme, /\/codex:setup --route implementation --model gpt-5\.6-terra --effort high/);
  assert.match(readme, /\/codex:setup --route implementation --clear/);
  assert.match(readme, /explicit `--model` and `--effort` override a route independently/i);
  assert.match(readme, /fresh rescue delegation, Codex may infer the narrowest matching route/i);
  assert.match(readme, /resumed rescue keeps its existing model and effort unless `--route`, `--model`, or `--effort` is explicit/i);
  assert.match(readme, /`max` and `ultra` are supported effort levels/i);
  assert.match(readme, /--model gpt-5\.4-mini --effort medium/i);
  assert.match(readme, /`spark`, the plugin maps that to `gpt-5\.3-codex-spark`/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /active `waitTimedOut: true` result is a durable handoff/i);
  assert.match(readme, /It preserves `jobId`/i);
  assert.match(readme, /Repeated attaches are idempotent and start no new implementation turn while active/i);
  assert.match(readme, /Delegated write runs use `features\.multi_agent=false`/i);
  assert.match(readme, /exact required install host-side/i);
  assert.match(readme, /workspace's existing package manager, proxy, and registry configuration/i);
  assert.doesNotMatch(readme, /monitoring loop/i);
  assert.match(readme, /### `\/codex:setup`/);
  assert.match(readme, /### `\/codex:review`/);
  assert.match(readme, /### `\/codex:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/codex:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/codex:rescue`/);
  assert.match(readme, /### `\/codex:transfer`/);
  assert.match(readme, /### `\/codex:status`/);
  assert.match(readme, /### `\/codex:result`/);
  assert.match(readme, /### `\/codex:cancel`/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gpt-5-4-prompting/SKILL.md");
  const promptRecipes = read("skills/gpt-5-4-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --wait --resume <delta>/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /--enable-review-gate\|--disable-review-gate/);
  assert.match(setup, /--route <name>/);
  assert.match(setup, /\[--model <id>\] \[--effort <level>\]/);
  assert.match(setup, /--route <name> --clear/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(readme, /!codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/codex:setup --enable-review-gate/);
  assert.match(readme, /\/codex:setup --disable-review-gate/);
});
