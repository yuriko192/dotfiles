---
name: create-rule
description: >
  Create pi context rules for persistent agent guidance. Use when adding coding
  standards, project conventions, AGENTS.md, SYSTEM.md, .pi/agent.md, or
  .pi/system.md.
---

# Creating Pi Context Rules

Pi has no `.cursor/rules/*.mdc` glob system. Persistent guidance lives in context files that pi loads from cwd up to the git root (or filesystem root).

When the user asks for a "rule", write the right file. Do not create Cursor `.mdc` files unless they explicitly want Cursor rules.

## Choose the File

| File | When to use |
|------|-------------|
| `AGENTS.md` | Repo-wide conventions every agent (pi, Cursor, others) should follow |
| `SYSTEM.md` | Text that should be appended to the system prompt |
| `.pi/agent.md` | Pi-only project guidance |
| `.pi/system.md` | Pi-only system prompt addition |

Prefer `AGENTS.md` for shared conventions. Use `.pi/agent.md` only when the guidance is pi-specific (extensions, `/skill:` commands, TUI).

In this dotfiles repo, repo-wide guidance belongs in `AGENTS.md`.

## Gather Requirements

1. **Purpose**: What should the rule enforce?
2. **Audience**: All agents (`AGENTS.md`) or pi only (`.pi/agent.md` / `.pi/system.md`)?
3. **Always vs situational**: Pi does not support `globs` / `alwaysApply`. Put file-specific rules in the body ("When editing `*.ts`, …") or split into a skill that loads on demand.

If the user wants file-pattern triggering, create a **skill** instead (`create-skill`) and put the pattern terms in the skill `description`.

## Format

Plain markdown. No required frontmatter.

```markdown
# TypeScript

- Prefer explicit return types on exported functions.
- Do not swallow errors in empty `catch` blocks.

\`\`\`typescript
// bad
try { await fetchData(); } catch (e) {}

// good
try {
  await fetchData();
} catch (error) {
  logger.error("Failed to fetch", { error });
  throw error;
}
\`\`\`
```

## Best Practices

- Keep each file concise and action-oriented.
- One concern per section. Split large dumps into focused headings or separate skills.
- Write like internal docs: concrete examples of the fix, not essays.
- Do not duplicate `AGENTS.md` into `.pi/agent.md` unless pi needs extra steps.

## Workflow

1. Read the existing target file if it exists.
2. Add only the new guidance. Preserve unrelated content.
3. If the same rule already lives in `AGENTS.md`, update that copy instead of forking it.
4. Tell the user pi picks up context files on the next session (or after `/reload` where applicable).
