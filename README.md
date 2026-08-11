# Dotfiles

Personal configs managed with [GNU Stow](https://www.gnu.org/software/stow/). Each top-level directory is a **package**. Stow symlinks the contents of a package into `$HOME`.

Helper scripts under `scripts/` wrap common workflows (link packages, import from `$HOME`, unstow files) with optional `fzf` TUIs.

## Prerequisites

```bash
brew install stow fzf
```

Clone this repo into `~/dotfiles` (or update the paths below if you use another location):

```bash
git clone <repo-url> ~/dotfiles
cd ~/dotfiles
```

## Layout

Paths inside a package mirror paths under `$HOME`:

```text
dotfiles/
├── scripts/                      helper CLIs (not a stow package)
├── zsh/.zshrc                    -> ~/.zshrc
├── nvim/.editorconfig            -> ~/.editorconfig
├── nvim/.config/nvim/...         -> ~/.config/nvim/...
├── tmux/.config/tmux/tmux.conf   -> ~/.config/tmux/tmux.conf
├── ghostty/.config/ghostty/config
├── starship/.config/starship.toml
├── lazygit/.config/lazygit/...
└── pi/.pi/...
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/link` | Symlink package(s) into `$HOME` (GNU Stow), with conflict prompts |
| `scripts/stow` | Import live `$HOME` paths into a package, then adopt/stow |
| `scripts/unstow` | Remove `$HOME` symlinks and move the real files out of the package |
| `scripts/tui` | Interactive entrypoint: pick `link` / `stow` / `unstow`, then packages/paths |
| `scripts/common.sh` | Shared helpers (sourced by the scripts above; not run directly) |

All interactive scripts expect `fzf`. Keys: `j`/`k` move, `/` search, `Tab` multi-select, `-` or `..` go back, `Esc` cancel.

### Link packages (restore / install)

```bash
cd ~/dotfiles
scripts/link              # pick package(s)
scripts/link zsh nvim     # link specific packages
scripts/tui               # choose link, then packages
```

On conflicts, `scripts/link` prompts per path:

- **package** — backup the live file (`*.bak.<timestamp>`), then link the package copy
- **home** — move the live file into the package (adopt), then link
- **cancel** — abort stowing that package

### Import from `$HOME` into a package

```bash
scripts/stow --package zsh .zshrc
scripts/stow --create-inferred .config/ghostty
scripts/stow                  # TUI: package (or + new) → files / ~/
```

### Unstow a file (real file in `$HOME`, removed from the package)

```bash
scripts/unstow .zshrc
scripts/unstow                # TUI: browse package trees
```

## Restore with raw Stow

From `~/dotfiles`, stow the packages you want:

```bash
cd ~/dotfiles

stow zsh
stow nvim
stow tmux
stow ghostty
stow starship
stow lazygit
stow pi
```

Or all at once:

```bash
stow zsh nvim tmux ghostty starship lazygit pi
```

Dry-run first (no changes):

```bash
stow -n -v zsh
```

Prefer `scripts/link` when you want conflict prompts instead of manual backup/adopt.

### If Stow refuses because a file already exists

**Option A — back up, then stow**

```bash
mv ~/.zshrc ~/.zshrc.bak
stow zsh
```

**Option B — adopt the existing file into the package, then re-stow**

`--adopt` moves the live file into the package (overwriting the package copy), then creates the symlink:

```bash
stow --adopt zsh
git diff   # review what changed in the package
stow -R zsh
```

Only use `--adopt` when you intend the device copy to become the source of truth.

## Add a new config

1. Create a package directory (or reuse an existing one).
2. Place the file using the same relative path it should have under `$HOME`.
3. Link the package (`scripts/link <pkg>` or `stow <pkg>`).
4. Commit.

Or import a live path with `scripts/stow`.

### Example: add `~/.gitconfig`

```bash
cd ~/dotfiles
mkdir -p git
mv ~/.gitconfig git/.gitconfig
scripts/link git
git add git
git commit -m "Add gitconfig via stow"
```

### Example: add a file under `~/.config`

```bash
cd ~/dotfiles
mkdir -p opencode/.config/opencode
mv ~/.config/opencode/opencode.jsonc opencode/.config/opencode/opencode.jsonc
scripts/link opencode
```

### Example: add into an existing package

```bash
cd ~/dotfiles
# e.g. put a new nvim plugin config in the nvim package
mv ~/.config/nvim/lua/custom/plugins/foo.lua \
  nvim/.config/nvim/lua/custom/plugins/foo.lua
stow -R nvim
# or: scripts/link nvim
```

## Update / restow

After pulling or editing package files:

```bash
cd ~/dotfiles
git pull
scripts/link zsh nvim tmux ghostty starship lazygit pi
# or: stow -R zsh nvim tmux ghostty starship lazygit pi
```

`stow -R` (restow) removes old symlinks for the package, then stows again.

## Remove a package from `$HOME`

```bash
cd ~/dotfiles
stow -D zsh
```

This only deletes the symlinks Stow created. Package files in the repo stay intact.

To turn individual stowed files into real `$HOME` files (and remove them from the package), use `scripts/unstow`.

## Useful Stow flags

| Flag | Meaning |
|------|---------|
| `-n` | Dry-run |
| `-v` | Verbose |
| `-R` | Restow |
| `-D` | Delete (unstow) |
| `--adopt` | Move conflicting live files into the package |

Target directory defaults to the parent of the stow directory (`~` when the repo lives at `~/dotfiles`). Override with `-t` if needed:

```bash
stow -t "$HOME" zsh
```

## Notes

- Prefer one package per tool (`zsh`, `nvim`, `tmux`, …).
- Do not commit secrets (tokens, `auth.json` with real credentials, private keys). Use empty stubs or keep those files unstowed on the machine.
- Avoid stowing large app data dirs (`node_modules`, session logs, databases). Stow only the config files you care about.
- See [AGENTS.md](AGENTS.md) for conventions when editing this repo with an AI agent.
