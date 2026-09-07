---
name: pi-agent-authoring
description: >
  Author pi coding agent artifacts such as extensions, skills, prompt templates,
  themes, context rules, and custom providers. Use whenever you are asked to
  create or modify anything that runs inside or extends the pi agent.
---

# Pi Agent Authoring

You are an expert in the **pi coding agent** ecosystem. When the user asks you to
create or modify a pi extension, skill, prompt template, theme, provider, or
rule/context file, follow this guide.

## Reference the official pi docs first

Read the relevant documentation from the local pi installation before writing
any artifact.

Locate pi docs:

```bash
# Global npm install
npm root -g
# pi docs live at: <npm-root>/@earendil-works/pi-coding-agent/docs/
```

Key docs to read on demand:

- **Extensions** — `docs/extensions.md`
- **Skills** — `docs/skills.md`
- **Prompt templates** — `docs/prompt-templates.md`
- **Themes** — `docs/themes.md`
- **Custom providers** — `docs/custom-provider.md`
- **Packages / distribution** — `docs/packages.md`
- **Models** — `docs/models.md`
- **Settings** — `docs/settings.md`

## Repository conventions

This repository is a GNU Stow–managed dotfiles repo. Each top-level directory
(except `scripts/`) is a stow package. Paths inside a package mirror paths
under `$HOME`. See `AGENTS.md` for detailed conventions and `README.md` for
usage.

- Prefer `scripts/link` for linking packages into `$HOME`.
- Prefer `scripts/stow` for importing live `$HOME` files into a package.
- Do not commit real credentials.
- Be careful with live `$HOME` files; `scripts/link` backs up on conflicts and
  never silently overwrites.

## Global vs project-local config locations

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/` — `extensions/`, `skills/`, `prompts/`, `themes/`, `settings.json`, etc. |
| Project-local | `.pi/` or `.agents/` inside the current project |

When adding a config to this dotfiles repo, place it under the appropriate stow
package (`pi/`, `cursor/`, etc.) at the `$HOME`-relative path.

## 1. Create a pi extension

For a full authoring workflow, load the dedicated `create-extension` skill
(`pi/.pi/agent/skills/create-extension/`).

Extensions are TypeScript modules loaded by pi.

Locations:

```text
~/.pi/agent/extensions/<name>.ts                         # single-file global
~/.pi/agent/extensions/<name>/index.ts                   # directory global
.pi/extensions/<name>.ts                                 # single-file project
.pi/extensions/<name>/index.ts                           # directory project
```

Minimum structure:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Event handlers, tools, commands, etc.
}
```

Guidelines:

- Keep the extension focused on one concern.
- Defer background work to `session_start`; clean up in `session_shutdown`.
- Register custom tools with `pi.registerTool()`, commands with
  `pi.registerCommand()`, shortcuts with `pi.registerShortcut()`.
- For tool schemas use `typebox` (already available to extensions).
- Do not start long-lived resources in the factory function; start them in
  `session_start`.
- Quick test: `pi -e ./path-to-extension.ts`.
- Hot reload: place in an auto-discovered location and run `/reload`.

## 2. Create a pi skill

For a full authoring workflow, load the dedicated `create-skill` skill
(`pi/.pi/agent/skills/create-skill/`). Related skills: `create-extension`,
`create-rule`, `create-prompt`, `create-subagent`, `update-settings`.

Skills follow the [Agent Skills](https://agentskills.io/specification) standard.

In this repo, global skills live at `pi/.pi/agent/skills/<skill-name>/SKILL.md`.

Structure:

```text
<skill-location>/<skill-name>/
├── SKILL.md
└── (optional scripts, references, assets)
```

`SKILL.md` frontmatter:

```markdown
---
name: <skill-name>
description: What this skill does and when to use it. Be specific.
---
```

Name rules:

- 1–64 characters, lowercase `a-z`, `0-9`, hyphens only.
- No leading/trailing or consecutive hyphens.

Guidelines:

- Include a clear `description`; this determines when pi loads the skill.
- Use relative paths from the skill directory for scripts and references.
- Keep setup, usage, and example sections.
- Validate with `pi --skill ./path/to/skill-dir`.

## 3. Create a pi prompt template

For a full authoring workflow, load the dedicated `create-prompt` skill
(`pi/.pi/agent/skills/create-prompt/`).

Prompt templates are Markdown snippets invoked by typing `/<name>` in pi.

Locations:

```text
~/.pi/agent/prompts/<name>.md
.pi/prompts/<name>.md
```

Format:

```markdown
---
description: Short description for autocomplete
argument-hint: "<arg>"
---
Prompt body with $1, $2, $@, or ${1:-default}.
```

Guidelines:

- Keep the template focused.
- Use frontmatter `argument-hint` for required/optional args.
- Use positional variables and defaults; see `docs/prompt-templates.md`.

## 4. Create a pi theme

Themes are JSON files.

Locations:

```text
~/.pi/agent/themes/<name>.json
.pi/themes/<name>.json
```

Read `docs/themes.md` for the theme schema and available tokens. Validate the
JSON and reload pi to see changes.

## 5. Create pi context rules

For a full authoring workflow, load the dedicated `create-rule` skill
(`pi/.pi/agent/skills/create-rule/`).

Pi reads project context from these files (searching from cwd up to git root or
filesystem root):

- `AGENTS.md` — repo-wide agent guidance and conventions.
- `SYSTEM.md` — appended to the system prompt.
- `.pi/agent.md` or `.pi/system.md` — pi-specific context.

When the user asks for “rules” for pi, choose the right file:

- `AGENTS.md` for project-wide conventions.
- `SYSTEM.md` for system prompt additions.
- `.pi/agent.md` or `.pi/system.md` for pi-only context.

Keep these files concise and action-oriented.

## 6. Create a custom provider

Providers can be added via an extension (see `docs/custom-provider.md`) or in
settings. Implement as an extension when you need dynamic model discovery or
runtime configuration.

## Testing

- For extensions and skills: `pi -e ./ext.ts` or `pi --skill ./skill-dir`.
- Run `/reload` in pi to pick up changes in auto-discovered locations.
- Watch pi startup output for warnings about invalid skill names, missing
  descriptions, or extension errors.

## Security

- Never commit credentials (`auth.json`, API tokens, private keys).
- Never install packages or run commands that mutate system state without user
  confirmation.
- Treat extensions as privileged code; they run with your user permissions.
