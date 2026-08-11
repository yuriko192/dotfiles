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

## Editing guidance

- Match existing script style: short header comment (what/why), small focused functions, fzf for interactive picks.
- Comments only when they explain why; do not remove unrelated existing comments.
- Update `README.md` when user-facing script behavior or workflows change.
- Update this file when agent-relevant conventions or script roles change.
- Do not run package installs via agent tooling beyond what’s already assumed (`stow`, `fzf` via Homebrew); if a new brew dependency is required, document it in the README prerequisites.

## Safety

- Avoid destructive git operations unless the user asks.
- Be careful with live `$HOME` files: `link` backs up on “keep package”; `stow --adopt` / “keep home” overwrites the package copy—call that out when relevant.
- Do not invent `--force` / silent overwrite paths that skip conflict prompts in `scripts/link`.
