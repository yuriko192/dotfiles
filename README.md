# Dotfiles

Personal configs managed with [GNU Stow](https://www.gnu.org/software/stow/). Each top-level directory is a **package**. Stow symlinks the contents of a package into `$HOME`.

## Prerequisites

```bash
brew install stow
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
├── zsh/.zshrc                    -> ~/.zshrc
├── nvim/.editorconfig            -> ~/.editorconfig
├── nvim/.config/nvim/...         -> ~/.config/nvim/...
├── tmux/.config/tmux/tmux.conf   -> ~/.config/tmux/tmux.conf
├── ghostty/.config/ghostty/config
├── starship/.config/starship.toml
├── lazygit/.config/lazygit/...
└── pi/.pi/...
```

## Restore (install on a machine)

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
3. Stow the package.
4. Commit.

### Example: add `~/.gitconfig`

```bash
cd ~/dotfiles
mkdir -p git
mv ~/.gitconfig git/.gitconfig
stow git
git add git
git commit -m "Add gitconfig via stow"
```

### Example: add a file under `~/.config`

```bash
cd ~/dotfiles
mkdir -p opencode/.config/opencode
mv ~/.config/opencode/opencode.jsonc opencode/.config/opencode/opencode.jsonc
stow opencode
```

### Example: add into an existing package

```bash
cd ~/dotfiles
# e.g. put a new nvim plugin config in the nvim package
mv ~/.config/nvim/lua/custom/plugins/foo.lua \
  nvim/.config/nvim/lua/custom/plugins/foo.lua
stow -R nvim
```

## Update / restow

After pulling or editing package files:

```bash
cd ~/dotfiles
git pull
stow -R zsh nvim tmux ghostty starship lazygit pi
```

`-R` (restow) removes old symlinks for the package, then stows again.

## Remove a package from `$HOME`

```bash
cd ~/dotfiles
stow -D zsh
```

This only deletes the symlinks Stow created. Package files in the repo stay intact.

## Useful flags

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
