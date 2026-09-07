---
name: create-prompt
description: >
  Create pi prompt templates invoked as /name. Use when adding a slash command,
  reusable prompt snippet, or converting a Cursor command into a pi template.
---

# Creating Pi Prompt Templates

Prompt templates are markdown files that expand when the user types `/<name>` in pi. They are the pi analog of Cursor `.cursor/commands/*.md`.

When the user wants a slash command that always expands the same prompt, write a template. When they want on-demand specialized procedure the model should follow, write a **skill** instead.

## Locations

| Scope | Path | Command |
|-------|------|---------|
| Global | `~/.pi/agent/prompts/<name>.md` | `/<name>` |
| Project | `.pi/prompts/<name>.md` | `/<name>` (trusted project) |

Discovery in `prompts/` is not recursive. In this dotfiles repo, global templates belong under `pi/.pi/agent/prompts/`.

## Format

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors
- Security issues
${1:-the full diff}
```

| Field | Required | Notes |
|-------|----------|-------|
| `description` | No | Autocomplete text. Falls back to the first non-empty line. |
| `argument-hint` | No | Shown in autocomplete. `<required>` and `[optional]`. |

Arguments:

- `$1`, `$2`, … positional
- `$@` or `$ARGUMENTS` all args
- `${1:-default}` default when missing
- `${@:N}` / `${@:N:L}` slices

## Workflow

1. Pick a filename. That becomes the `/name`.
2. Write a focused prompt. Do not dump a whole skill into a template.
3. Add `argument-hint` when the command takes args.
4. Reload pi or start a new session. Test `/name` from the editor.

See local docs: `docs/prompt-templates.md` in the pi-coding-agent package.
