---
name: update-settings
description: >
  View and modify pi settings in ~/.pi/agent/settings.json or .pi/settings.json.
  Use when the user wants to change theme, model defaults, compaction, retry,
  tools, skills paths, or other pi CLI/TUI preferences.
---

# Pi Settings

Edit pi JSON settings. Project settings override global settings. Nested objects merge.

## Files

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/settings.json` |
| Project | `.pi/settings.json` |

In this dotfiles repo, the global file is `pi/.pi/agent/settings.json`.

Read the file first. Change only what the user asked for. Keep valid JSON. Do not commit secrets (`auth.json`, tokens).

Interactive alternatives the user can use themselves: `/settings`, `/model` then Ctrl+S, `/thinking` then Ctrl+S.

Read local docs before guessing keys: `docs/settings.md` in `@earendil-works/pi-coding-agent`.

## Keys people ask for

| Request | Setting |
|---------|---------|
| Default model / provider | `defaultProvider`, `defaultModel` |
| Thinking level | `defaultThinkingLevel` (`off` … `max`) |
| Theme | `theme` |
| Hide thinking | `hideThinkingBlock` |
| Compaction | `compaction.enabled`, `reserveTokens`, `keepRecentTokens` |
| Retry | `retry.enabled`, `retry.maxRetries` |
| Built-in tools | `defaultTools` (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, …) |
| Extra skill dirs | `skills` (array of paths) |
| Skill slash commands | `enableSkillCommands` (default `true`) |
| Extensions / prompts / themes | `extensions`, `prompts`, `themes` |
| Packages | `packages` |
| External editor | `externalEditor` |
| TUI mode | `tuiMode` (`regular` / `fullscreen`) |
| Session dir | `sessionDir` |
| HTTP proxy | `httpProxy` (global only) |
| Project trust fallback | `defaultProjectTrust` (`ask` / `always` / `never`, global only) |

Do not hand-edit `auth.json` or `models-store.json` as a substitute for settings.

## Workflow

1. Read the existing settings file.
2. Apply the requested change. Preserve unrelated keys.
3. Validate JSON.
4. Tell the user which file changed and whether they need a new session or `/reload`.
