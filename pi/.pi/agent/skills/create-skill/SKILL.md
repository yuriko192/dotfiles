---
name: create-skill
description: >
  Create pi agent skills. Use when authoring a new skill, asking about SKILL.md
  structure, or converting a workflow into ~/.pi/agent/skills or .pi/skills.
---

# Creating Skills in Pi

Skills are directories with a `SKILL.md` that teach pi how to perform a specific task. Pi implements the [Agent Skills](https://agentskills.io/specification) standard.

When the user asks for a skill, gather missing requirements, then write the files. Do not stop at describing the format.

## Gather Requirements

1. **Purpose**: What task should this skill handle?
2. **Scope**: Global (`~/.pi/agent/skills/`) or project (`.pi/skills/`)?
3. **Triggers**: When should pi load it? Put those terms in `description`.
4. **Invocation**: Auto-discovered from description, or `/skill:name` only (`disable-model-invocation: true`)?
5. **Supporting files**: Scripts, references, or assets?

Infer from conversation. Only ask for what is still missing. If `ask_user` is available, use it.

In this dotfiles repo, global skills belong under `pi/.pi/agent/skills/<name>/` (stows to `~/.pi/agent/skills/<name>/`).

## Locations

| Type | Path | Scope |
|------|------|-------|
| Global | `~/.pi/agent/skills/<name>/SKILL.md` | All projects |
| Project | `.pi/skills/<name>/SKILL.md` | Current trusted project |
| Shared | `.agents/skills/<name>/SKILL.md` | Other harnesses + pi |

Also loadable via `settings.json` `skills` array, packages (`pi.skills`), or `pi --skill <path>`.

Prefer project skills when the workflow should be committed with the repo.

## Structure

```text
<skill-name>/
├── SKILL.md
├── scripts/          # optional helpers the agent should run
├── references/       # optional docs loaded on demand
└── assets/
```

```markdown
---
name: skill-name
description: What this skill does and when to use it. Include trigger terms.
---

# Skill Title

## Usage
Step-by-step instructions.

## Examples
Concrete inputs and outputs.
```

### Frontmatter

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | 1–64 chars, lowercase `a-z` `0-9` hyphens. No leading, trailing, or consecutive hyphens. |
| `description` | Yes | Max 1024 chars. WHAT + WHEN. This is what pi puts in the system prompt. |
| `disable-model-invocation` | No | `true` hides it from auto-discovery; user must run `/skill:name`. |
| `compatibility` | No | Environment requirements. |
| `allowed-tools` | No | Experimental space-separated pre-approved tools. |

Pi does not require `name` to match the directory, but matching them avoids confusion.

## Description

Write in third person. Include trigger phrases.

```yaml
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDFs, forms, or document extraction.
```

Avoid first person and vague lines like "Helps with documents."

## Authoring Rules

- Keep `SKILL.md` under 500 lines. Put deep reference in `references/` and link one level deep.
- Assume the model is capable. Only add what it would not already know.
- Use relative paths from the skill directory.
- Match specificity to fragility: prose for judgment, templates for preferred shape, scripts when consistency matters.
- Do not invent `--force` paths or skip safety prompts that already exist in this repo's scripts.

## Workflow

1. Choose name, location, and whether it auto-invokes.
2. Write `SKILL.md` with frontmatter + instructions.
3. Add scripts or references only when they earn their tokens.
4. Validate: `pi --skill ./path/to/skill-dir`
5. In an auto-discovered location, run `/reload` or start a new session.
6. Invoke with `/skill:<name>` or a matching user request.

## Checklist

- [ ] `name` and `description` valid
- [ ] Description includes WHAT and WHEN
- [ ] Body is concise and actionable
- [ ] Paths are relative and one level deep
- [ ] Validated with `pi --skill`
