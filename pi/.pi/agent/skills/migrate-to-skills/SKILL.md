---
name: migrate-to-skills
description: >
  Convert Cursor rules (.cursor/rules/*.mdc), Cursor slash commands
  (.cursor/commands/*.md), and pi prompt templates into pi Agent Skills. Use
  when migrating rules or commands to ~/.pi/agent/skills or .pi/skills.
disable-model-invocation: true
---

# Migrate Rules and Commands to Pi Skills

Convert Cursor "applied intelligently" rules, Cursor slash commands, and (optionally) pi prompt templates into Agent Skills for pi.

**Preserve the exact body content. Do not reformat, fix typos, or "improve" it.**

## Destinations

| Level | Destination |
|-------|-------------|
| Global | `~/.pi/agent/skills/<name>/SKILL.md` |
| Project | `.pi/skills/<name>/SKILL.md` |
| This repo | `pi/.pi/agent/skills/<name>/SKILL.md` |

Ignore `~/.cursor/worktrees` and `~/.cursor/skills-cursor`.

## What to Migrate

**Cursor rules** (`.mdc`): migrate if the rule has a `description` and does **not** have `globs` and does **not** have `alwaysApply: true`. File-specific / always-on rules stay as context (`create-rule`).

**Cursor commands** (`.md`): migrate all. They are explicit invocations.

**Pi prompt templates**: migrate only when the user asks. Templates that should stay one-shot `/name` expansions can remain prompts.

## Conversion

### Rule `.mdc` → skill

Keep the body exactly. Add `name`, drop `globs` / `alwaysApply`.

```markdown
---
name: my-rule
description: What this rule does
---
# Title
Body content...
```

### Command `.md` → skill

Infer `description` from the first heading. Set `disable-model-invocation: true` so it stays user-triggered (`/skill:name`).

```markdown
---
name: commit
description: Commit current work with standardized message format
disable-model-invocation: true
---
# Commit current work
Instructions here...
```

`name` is the filename without extension, lowercase hyphens only.

## Workflow

1. Create the destination skills directory if needed.
2. Find candidates:
   - `{workspace}/**/.cursor/rules/*.mdc`
   - `{workspace}/**/.cursor/commands/*.md`
   - `~/.cursor/commands/*.md`
   - optionally `~/.pi/agent/prompts/*.md` and `.pi/prompts/*.md`
3. Read each file with the read tool (not the shell).
4. Write the skill with the edit/write tool. Copy the body character-for-character.
5. Delete the original only after the skill is written, and only if the user wants the source removed. Prefer keeping Cursor files unless they asked to delete them.
6. Summarize what moved. Tell the user they can ask to undo.

Do not use the terminal to read, write, or delete these files.
