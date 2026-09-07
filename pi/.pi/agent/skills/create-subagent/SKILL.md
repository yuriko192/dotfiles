---
name: create-subagent
description: >
  Create specialized pi subagents. Use when adding isolated task agents, a
  reviewer, scout, planner, or worker under ~/.pi/agent/agents or .pi/agents.
disable-model-invocation: true
---

# Creating Pi Subagents

Pi does not ship Cursor-style built-in subagents. Isolated agents are markdown files consumed by the official **subagent** example extension (`examples/extensions/subagent` in `@earendil-works/pi-coding-agent`).

If that extension is not installed, say so and offer one of:

1. Install/copy the official subagent extension, then add agent files (this skill).
2. Write a **skill** (`create-skill`) for an in-session specialized workflow.
3. Write a **prompt template** (`create-prompt`) for a `/name` invocation.

Do not invent a Task tool or Cursor `subagent_type`.

## Agent Files

| Location | Scope |
|----------|-------|
| `~/.pi/agent/agents/<name>.md` | User-level, always loaded by the extension |
| `.pi/agents/<name>.md` | Project-level; only with `agentScope: "project"` or `"both"` |

Project agents override user agents with the same name when both are enabled. Only enable project agents in trusted repos.

In this dotfiles repo, user agents belong under `pi/.pi/agent/agents/`.

## File Format

```markdown
---
name: code-reviewer
description: Expert code review specialist. Use immediately after writing or modifying code.
tools: read, grep, find, ls, bash
---

You are a senior code reviewer. When invoked:

1. Inspect the requested diff or paths.
2. Review correctness, security, and maintainability.
3. Report findings by severity with `file:line`.
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | Lowercase letters and hyphens |
| `description` | Yes | When the parent agent should delegate. Include trigger terms. |
| `tools` | No | Comma-separated allowlist. Omit for the extension default set. |
| `model` | No | Pin a model. Omit to inherit the parent session model and thinking level. |

The markdown body is the subagent system prompt.

## Writing Descriptions

```yaml
# bad
description: Helps with code

# good
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
```

## Workflow

1. Confirm the subagent extension is present (`~/.pi/agent/extensions/subagent/`).
2. Choose user vs project location.
3. Write `<name>.md` with frontmatter + system prompt.
4. Keep the agent focused on one job. Restrict `tools` when it should be read-only.
5. Test by asking pi to delegate: `Use the code-reviewer agent to review the current diff`.

If the extension is missing, point the user at the local example:

```text
$(npm root -g)/@earendil-works/pi-coding-agent/examples/extensions/subagent/
```

Copy `index.ts` and `agents.ts` into `~/.pi/agent/extensions/subagent/`, then add agent markdown files. Do not run package installs unless the user asks.

## Built-in Examples (upstream)

| Agent | Role |
|-------|------|
| `scout` | Fast recon, compressed context |
| `planner` | Implementation plan |
| `reviewer` | Code review |
| `worker` | General implementation |
