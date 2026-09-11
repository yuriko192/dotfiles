# AGENTS.md

Guidance for AI agents working in this repository.

## What this repo is

GNU Stow–managed personal dotfiles. Each **top-level directory except `scripts/`** is a stow **package**. Paths inside a package mirror paths under `$HOME` (e.g. `zsh/.zshrc` → `~/.zshrc`).

## Scripts

Shared logic lives in `scripts/common.sh`. Entrypoints:

| Script | Role |
|--------|------|
| `scripts/link` | Run `stow` on chosen packages; prompt on conflicts (`package` / `home` / `cancel`) |
| `scripts/stow` | Import live `$HOME` files into a package, then `stow --adopt` |
| `scripts/unstow` | Replace `$HOME` symlink with the real file moved out of the package |
| `scripts/tui` | fzf flow: action → packages → paths (for stow/unstow) or link |

- Prefer these scripts over inventing new symlink/import flows.
- Reuse helpers in `common.sh` (`list_packages`, `pick_packages`, `fzf_vim`, `home_file_status`, …).
- Keep scripts `bash`, `set -euo pipefail`, and source `common.sh` the same way existing scripts do.
- Do not treat `scripts/` as a stow package (`list_packages` already skips it).

## Package conventions

- One package per tool (`zsh`, `nvim`, `tmux`, …).
- Only add config you intend to symlink; skip secrets, caches, logs, and bulky app data.
- Never commit real credentials (`auth.json`, tokens, private keys). Prefer stubs or leave those paths unstowed.
- When adding a config, place it at the `$HOME`-relative path inside the package, then link with `scripts/link` (or document raw `stow` if appropriate).
- Pi global skills live in `pi/.pi/agent/skills/<name>/SKILL.md` (stows to `~/.pi/agent/skills/`). Follow the Agent Skills standard (`name` + `description` frontmatter). Validate with `pi --skill ./path/to/skill-dir`.
- Pi MCP support is the `mcp` extension (`pi/.pi/agent/extensions/mcp/`). It must be linked to `~/.pi/agent/extensions/mcp` or Pi will not load it (`scripts/link pi` can abort on `settings.json` / `models.json` conflicts; symlink the `mcp` directory in that case). It is a client for **external** MCP servers. On session start (and `/mcp import`) it scans Cursor, Claude, Claude Desktop, VS Code, Copilot, and shared MCP files, then writes `~/.pi/agent/mcp.json`. Do not commit that file. User-owned servers in the Pi file are not overwritten; same-name clashes from another host are stored as `host_name`. Project override: `.pi/mcp.json`. A URL ending in `/sse` uses legacy SSE. The agent uses one `mcp` proxy tool. `/mcp`, `/mcp:import`, `/mcp:start`, `/mcp:stop` manage connections.
- Pi 9router support is the `9router` extension (`pi/.pi/agent/extensions/9router/`). It must be linked to `~/.pi/agent/extensions/9router` or Pi will not load it (same `settings.json` / `models.json` conflict caveat as MCP). It registers provider `9router` from the OpenAI-compatible catalog at `GET /v1/models` (default `http://localhost:20128/v1`). Env overrides: `NINE_ROUTER_BASE_URL` / `9ROUTER_BASE_URL`, `NINE_ROUTER_API_KEY` / `9ROUTER_API_KEY`, `NINE_ROUTER_ENABLE_REASONING` / `9ROUTER_ENABLE_REASONING`. Optional disk config is `~/.pi/agent/9router-config.json` — do not commit that file. Commands: `/9router`, `/9router:setup`, `/9router:refresh`. Do not also add a static `9router` block in `models.json`. Cursor routes (`cu/*`) go through AgentService and reject Pi tools (`unsupported IDE tool`); the extension forces Chat Completions on first turn and warns. Use `cc/` or `cosmoshub/` for agent work.

## Editing guidance

- Match existing script style: short header comment (what/why), small focused functions, fzf for interactive picks.
- Comments only when they explain why; do not remove unrelated existing comments.
- Update `README.md` when user-facing script behavior or workflows change.
- Update this file when agent-relevant conventions or script roles change.
- Do not run package installs via agent tooling beyond what’s already assumed (`stow`, `fzf` via Homebrew); if a new brew dependency is required, document it in the README prerequisites.
- Neovim is 0.12. Keep `nvim-treesitter` on `branch = 'main'` with `version = false` (not `master`). Tag `v0.10.0` still points at archived `master` and crashes markdown highlighting (`node:range` is nil). Use `require('nvim-treesitter').get_available()` and `install(lang):await(...)` — not the old `parsers.available_parsers()` / `install()(lang)` factory. Leftover `parser/*.so` in the plugin checkout shadow bundled parsers; the FileType attach path skips that directory and deletes leftovers that have a bundled/site copy. Parser install needs `tree-sitter` CLI (`tree-sitter-cli`); without it, highlighting still uses bundled/already-installed parsers. Keep `go.nvim` on `branch = 'master'` (Neovim 0.12). Tag `v0.11` is only for Neovim 0.11 / treesitter `master`. Current `master` `pcall`s `nvim-treesitter.configs` so textobjects no longer crash on treesitter `main`.

## Safety

- Avoid destructive git operations unless the user asks.
- Be careful with live `$HOME` files: `link` backs up on “keep package”; `stow --adopt` / “keep home” overwrites the package copy—call that out when relevant.
- Do not invent `--force` / silent overwrite paths that skip conflict prompts in `scripts/link`.
