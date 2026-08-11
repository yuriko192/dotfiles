#!/usr/bin/env bash
# Shared helpers for scripts/link, scripts/stow, scripts/unstow, and scripts/tui.

# Repo root is the parent of scripts/; stow packages live here as top-level dirs.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:-}"

# Sentinel row / keymap target meaning "go back to the parent picker".
BACK_ENTRY=".."
# Row that opens the $HOME browser from the package file picker (stow only).
HOME_ENTRY="~/"
# Row to create a new package named via path inference (stow only).
NEW_PACKAGE_ENTRY="+ new (inferred)"

# Fail fast when the stow target (~) is unknown.
require_home() {
  if [[ -z "$HOME_DIR" ]]; then
    echo "HOME is not set" >&2
    exit 1
  fi
}

# Stow is required to adopt/link package files into $HOME.
require_stow() {
  if ! command -v stow >/dev/null 2>&1; then
    echo "stow not found; install with: brew install stow" >&2
    exit 1
  fi
}

# fzf powers the interactive package/file pickers.
require_fzf() {
  if ! command -v fzf >/dev/null 2>&1; then
    echo "fzf not found; install with: brew install fzf" >&2
    exit 1
  fi
}

# Vim-style list navigation. Search starts disabled so j/k move the cursor;
# press / to toggle fuzzy search (Esc still cancels the picker).
# Use --back so typing - goes up: fzf cannot bind the - key itself (it always
# puts - into the query), so we watch change and become when the query is -.
fzf_vim() {
  local with_back=0
  if [[ "${1:-}" == "--back" ]]; then
    shift
    with_back=1
  fi

  if [[ $with_back -eq 1 ]]; then
    fzf \
      --disabled \
      --bind 'j:down,k:up,g:first,G:last' \
      --bind 'ctrl-d:half-page-down,ctrl-u:half-page-up' \
      --bind 'ctrl-f:page-down,ctrl-b:page-up' \
      --bind '/:toggle-search' \
      --bind "change:transform:[[ {q} = - ]] && echo become:/bin/echo\\ ${BACK_ENTRY}" \
      --reverse \
      --border \
      "$@"
  else
    fzf \
      --disabled \
      --bind 'j:down,k:up,g:first,G:last' \
      --bind 'ctrl-d:half-page-down,ctrl-u:half-page-up' \
      --bind 'ctrl-f:page-down,ctrl-b:page-up' \
      --bind '/:toggle-search' \
      --reverse \
      --border \
      "$@"
  fi
}

# Normalize user input to a path relative to $HOME.
normalize_relative_path() {
  local input="$1"
  input="${input/#\~\//}"
  input="${input/#$HOME_DIR\//}"
  input="${input#./}"
  printf '%s\n' "$input"
}

# List stow packages (top-level dirs), excluding this scripts/ folder.
list_packages() {
  local dir name
  for dir in "$REPO_ROOT"/*/; do
    [[ -d "$dir" ]] || continue
    name="$(basename "$dir")"
    case "$name" in
      scripts) continue ;;
    esac
    printf '%s\n' "$name"
  done | sort
}

# List files inside a package as $HOME-relative paths (mirrors stow layout).
list_package_files() {
  local package="$1"
  local package_root="$REPO_ROOT/$package"

  if [[ ! -d "$package_root" ]]; then
    return 0
  fi

  find "$package_root" -type f \
    ! -name '.DS_Store' \
    ! -name '.nvimlog' \
    ! -path '*/.git/*' \
    -print \
    | sed "s|^$package_root/||" \
    | sort
}

# Describe how a package file currently exists under $HOME (for the TUI).
# Prints one of: stowed | real | other | absent
home_file_status() {
  local relative_path="$1"
  local live_path="$HOME_DIR/$relative_path"

  if [[ -L "$live_path" ]]; then
    printf 'stowed'
  elif [[ -f "$live_path" ]]; then
    printf 'real'
  elif [[ -e "$live_path" ]]; then
    printf 'other'
  else
    printf 'absent'
  fi
}

# True when the fzf selection means "go back" (.. only, or - keymap).
selection_is_back() {
  local line count=0
  local has_other=0

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    count=$((count + 1))
    if [[ "$line" != "$BACK_ENTRY" ]]; then
      has_other=1
    fi
  done <<<"${1:-}"

  [[ $count -gt 0 && $has_other -eq 0 ]]
}

# Drop .. and ~/ sentinel rows from a multi-select.
strip_back_entries() {
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    [[ "$line" == "$BACK_ENTRY" ]] && continue
    [[ "$line" == "$HOME_ENTRY" ]] && continue
    printf '%s\n' "$line"
  done <<<"${1:-}"
}

# True when the selection means "browse $HOME" (~/ only).
selection_is_home_browser() {
  local line count=0
  local has_other=0

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    count=$((count + 1))
    if [[ "$line" != "$HOME_ENTRY" ]]; then
      has_other=1
    fi
  done <<<"${1:-}"

  [[ $count -gt 0 && $has_other -eq 0 ]]
}

# Count non-empty lines in a string.
count_lines() {
  local line count=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    count=$((count + 1))
  done <<<"${1:-}"
  printf '%s\n' "$count"
}

# List one directory under $HOME for the browser (dirs end with /).
list_home_browser_entries() {
  local relative_dir="${1:-}"
  local abs="$HOME_DIR"
  local entry name

  if [[ -n "$relative_dir" ]]; then
    abs="$HOME_DIR/$relative_dir"
  fi

  if [[ ! -d "$abs" ]]; then
    return 0
  fi

  # Select this directory as a whole (not offered at $HOME root).
  if [[ -n "$relative_dir" ]]; then
    printf '%s\n' "."
  fi

  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    name="$(basename "$entry")"
    case "$name" in
      .DS_Store | .Trash) continue ;;
    esac
    if [[ -d "$entry" ]]; then
      printf '%s/\n' "$name"
    elif [[ -f "$entry" || -L "$entry" ]]; then
      printf '%s\n' "$name"
    fi
  done < <(find "$abs" -mindepth 1 -maxdepth 1 | LC_ALL=C sort)
}

# Join a parent relative dir with a child name into a $HOME-relative path.
join_home_relative() {
  local parent="${1:-}"
  local child="$2"

  if [[ -z "$parent" ]]; then
    printf '%s\n' "$child"
  else
    printf '%s\n' "$parent/$child"
  fi
}

# Browse $HOME and pick files and/or directories to stow.
# Enter opens a directory, or selects a file (Tab multi-select then Enter confirms).
# Press . to stow the highlighted directory (or the current directory if on a file / .).
# Return codes:
#   0  selected $HOME-relative path(s) printed to stdout
#   1  cancelled / empty selection
#   3  user chose .. / - at $HOME root (go back)
pick_home_paths() {
  local current=""
  local selected cleaned line name target count
  local -a results=()

  while true; do
    selected="$(
      {
        printf '%s\n' "$BACK_ENTRY"
        list_home_browser_entries "$current"
      } | fzf_vim --back --multi \
        --bind "change:transform:
          if [[ {q} = - ]]; then
            echo become:/bin/echo\\ ${BACK_ENTRY}
          elif [[ {q} = . ]]; then
            echo become:/bin/echo\\ STOWDIR:{1}
          fi" \
        --prompt "Home:${current:-/}> " \
        --header 'Enter open dir / select file · . stow dir · Tab multi · - or .. up' \
        --height 80%
    )" || true

    if [[ -z "${selected:-}" ]]; then
      return 1
    fi

    if selection_is_back "$selected"; then
      if [[ -z "$current" ]]; then
        return 3
      fi
      current="$(dirname "$current")"
      [[ "$current" == "." ]] && current=""
      continue
    fi

    # . keymap → stow highlighted directory (or current dir when on a file / .).
    if [[ "$selected" == STOWDIR:* ]]; then
      name="${selected#STOWDIR:}"
      name="${name%/}"
      if [[ -z "$name" || "$name" == "$BACK_ENTRY" || "$name" == "." ]]; then
        if [[ -z "$current" ]]; then
          echo "Cannot stow entire \$HOME; open a subdirectory first." >&2
          continue
        fi
        printf '%s\n' "$current"
        return 0
      fi
      target="$(join_home_relative "$current" "$name")"
      if [[ -d "$HOME_DIR/$target" ]]; then
        printf '%s\n' "$target"
        return 0
      fi
      if [[ -n "$current" ]]; then
        printf '%s\n' "$current"
        return 0
      fi
      echo "Cannot stow entire \$HOME; highlight a directory or open one first." >&2
      continue
    fi

    cleaned="$(strip_back_entries "$selected")"
    if [[ -z "$cleaned" ]]; then
      if [[ -z "$current" ]]; then
        return 3
      fi
      current="$(dirname "$current")"
      [[ "$current" == "." ]] && current=""
      continue
    fi

    count="$(count_lines "$cleaned")"

    # Enter on a single directory → open it.
    if [[ "$count" -eq 1 && "$cleaned" == */ ]]; then
      name="${cleaned%/}"
      current="$(join_home_relative "$current" "$name")"
      continue
    fi

    # Enter on . → stow current directory.
    if [[ "$count" -eq 1 && "$cleaned" == "." ]]; then
      if [[ -z "$current" ]]; then
        echo "Cannot stow entire \$HOME; open a subdirectory first." >&2
        continue
      fi
      printf '%s\n' "$current"
      return 0
    fi

    # Enter on file(s) / Tab multi-select → stow those paths.
    results=()
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      if [[ "$line" == "." ]]; then
        if [[ -z "$current" ]]; then
          echo "Cannot stow entire \$HOME; open a subdirectory first." >&2
          continue
        fi
        results+=("$current")
        continue
      fi
      name="${line%/}"
      [[ -z "$name" ]] && continue
      target="$(join_home_relative "$current" "$name")"
      results+=("$target")
    done <<<"$cleaned"

    if [[ ${#results[@]} -eq 0 ]]; then
      continue
    fi

    printf '%s\n' "${results[@]}"
    return 0
  done
}

# List one directory across the given packages (dirs end with /).
# relative_dir is $HOME-relative (mirrors paths inside each package).
list_package_browser_entries() {
  local relative_dir="${1:-}"
  shift || true
  local packages=("$@")
  local package abs entry name
  local -a entries=()

  if [[ ${#packages[@]} -eq 0 ]]; then
    return 0
  fi

  if [[ -n "$relative_dir" ]]; then
    printf '%s\n' "."
  fi

  for package in "${packages[@]}"; do
    if [[ -n "$relative_dir" ]]; then
      abs="$REPO_ROOT/$package/$relative_dir"
    else
      abs="$REPO_ROOT/$package"
    fi
    [[ -d "$abs" ]] || continue

    while IFS= read -r entry; do
      [[ -n "$entry" ]] || continue
      name="$(basename "$entry")"
      case "$name" in
        .DS_Store | .nvimlog) continue ;;
      esac
      if [[ -d "$entry" ]]; then
        entries+=("$name/")
      elif [[ -f "$entry" || -L "$entry" ]]; then
        entries+=("$name")
      fi
    done < <(find "$abs" -mindepth 1 -maxdepth 1 | LC_ALL=C sort)
  done

  if [[ ${#entries[@]} -gt 0 ]]; then
    printf '%s\n' "${entries[@]}" | LC_ALL=C sort -u
  fi
}

# Browse package trees and pick files and/or directories to unstow.
# Enter opens a directory, or selects a file (Tab multi-select then Enter confirms).
# Press . to unstow the highlighted directory (or the current directory if on a file / .).
# Return codes:
#   0  selected $HOME-relative path(s) printed to stdout
#   1  cancelled / empty selection
#   3  user chose .. / - at package root (go back)
pick_package_paths() {
  local packages=("$@")
  local current=""
  local selected cleaned line name target count
  local -a results=()

  if [[ ${#packages[@]} -eq 0 ]]; then
    echo "No packages provided." >&2
    return 1
  fi

  while true; do
    selected="$(
      {
        printf '%s\n' "$BACK_ENTRY"
        list_package_browser_entries "$current" "${packages[@]}"
      } | fzf_vim --back --multi \
        --bind "change:transform:
          if [[ {q} = - ]]; then
            echo become:/bin/echo\\ ${BACK_ENTRY}
          elif [[ {q} = . ]]; then
            echo become:/bin/echo\\ STOWDIR:{1}
          fi" \
        --prompt "Pkg:${current:-/}> " \
        --header 'Enter open dir / select file · . unstow dir · Tab multi · - or .. up' \
        --height 80%
    )" || true

    if [[ -z "${selected:-}" ]]; then
      return 1
    fi

    if selection_is_back "$selected"; then
      if [[ -z "$current" ]]; then
        return 3
      fi
      current="$(dirname "$current")"
      [[ "$current" == "." ]] && current=""
      continue
    fi

    # . keymap → unstow highlighted directory (or current dir when on a file / .).
    if [[ "$selected" == STOWDIR:* ]]; then
      name="${selected#STOWDIR:}"
      name="${name%/}"
      if [[ -z "$name" || "$name" == "$BACK_ENTRY" || "$name" == "." ]]; then
        if [[ -z "$current" ]]; then
          echo "Cannot unstow package root; open a subdirectory or select files." >&2
          continue
        fi
        printf '%s\n' "$current"
        return 0
      fi
      target="$(join_home_relative "$current" "$name")"
      if package_tree_has_dir "$target" "${packages[@]}"; then
        printf '%s\n' "$target"
        return 0
      fi
      if [[ -n "$current" ]]; then
        printf '%s\n' "$current"
        return 0
      fi
      echo "Cannot unstow package root; highlight a directory or open one first." >&2
      continue
    fi

    cleaned="$(strip_back_entries "$selected")"
    if [[ -z "$cleaned" ]]; then
      if [[ -z "$current" ]]; then
        return 3
      fi
      current="$(dirname "$current")"
      [[ "$current" == "." ]] && current=""
      continue
    fi

    count="$(count_lines "$cleaned")"

    # Enter on a single directory → open it.
    if [[ "$count" -eq 1 && "$cleaned" == */ ]]; then
      name="${cleaned%/}"
      current="$(join_home_relative "$current" "$name")"
      continue
    fi

    # Enter on . → unstow current directory.
    if [[ "$count" -eq 1 && "$cleaned" == "." ]]; then
      if [[ -z "$current" ]]; then
        echo "Cannot unstow package root; open a subdirectory or select files." >&2
        continue
      fi
      printf '%s\n' "$current"
      return 0
    fi

    # Enter on file(s) / Tab multi-select → unstow those paths.
    results=()
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      if [[ "$line" == "." ]]; then
        if [[ -z "$current" ]]; then
          echo "Cannot unstow package root; open a subdirectory or select files." >&2
          continue
        fi
        results+=("$current")
        continue
      fi
      name="${line%/}"
      [[ -z "$name" ]] && continue
      target="$(join_home_relative "$current" "$name")"
      results+=("$target")
    done <<<"$cleaned"

    if [[ ${#results[@]} -eq 0 ]]; then
      continue
    fi

    printf '%s\n' "${results[@]}"
    return 0
  done
}

# True when any of the packages has this $HOME-relative directory.
package_tree_has_dir() {
  local relative_dir="$1"
  shift || true
  local package

  for package in "$@"; do
    if [[ -d "$REPO_ROOT/$package/$relative_dir" ]]; then
      return 0
    fi
  done
  return 1
}
# Ask whether to link (stow packages), stow (import/adopt), or unstow.
# Return codes:
#   0  Success, selected action printed to stdout
#   1  Cancelled, empty selection
pick_action() {
  local selected
  selected="$(
    printf '%s\n' \
      'link    symlink package(s) into $HOME' \
      'stow    import live $HOME paths into a package' \
      'unstow  move stowed files out of a package' \
      | fzf_vim --prompt 'Action> ' \
        --header 'j/k move · g/G top/bottom · / search · Enter confirm' \
        --height 40%
  )" || true

  if [[ -z "${selected:-}" ]]; then
    return 1
  fi

  printf '%s\n' "${selected%% *}"
}

# Let the user pick package(s) to operate on.
# Options:
#   --allow-new   include "+ new (inferred)" (stow)
#   --single      single-select instead of multi
# Return codes:
#   0  selected package name(s) printed to stdout
#   1  cancelled / empty selection
#   3  user chose .. / - (go back)
pick_packages() {
  local allow_new=0
  local single=0
  local selected cleaned
  local -a fzf_extra=(--multi)
  local header='j/k move · Tab multi-select · - or .. back · / search · Enter confirm'

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --allow-new) allow_new=1 ;;
      --single)
        single=1
        fzf_extra=()
        ;;
      *)
        echo "pick_packages: unknown option: $1" >&2
        return 1
        ;;
    esac
    shift
  done

  if [[ $allow_new -eq 1 ]]; then
    header='+ new (inferred) · j/k move · - or .. back · / search · Enter confirm'
  fi
  if [[ $single -eq 1 ]]; then
    header="${header/Tab multi-select · /}"
  fi

  selected="$(
    {
      printf '%s\n' "$BACK_ENTRY"
      if [[ $allow_new -eq 1 ]]; then
        printf '%s\n' "$NEW_PACKAGE_ENTRY"
      fi
      list_packages
    } | fzf_vim --back ${fzf_extra[@]+"${fzf_extra[@]}"} --prompt 'Package(s)> ' \
      --header "$header" \
      --height 60%
  )" || true

  if [[ -z "${selected:-}" ]]; then
    return 1
  fi

  if selection_is_back "$selected"; then
    return 3
  fi

  cleaned="$(strip_back_entries "$selected")"
  if [[ -z "$cleaned" ]]; then
    return 3
  fi

  # New-package row must be chosen alone.
  if [[ "$cleaned" == *"$NEW_PACKAGE_ENTRY"* && "$cleaned" != "$NEW_PACKAGE_ENTRY" ]]; then
    echo "Pick either an existing package or '+ new (inferred)', not both." >&2
    return 1
  fi

  printf '%s\n' "$cleaned"
}

# Let the user pick files from the given packages.
# Optional filter limits rows by home status: all | stowed | real | absent | other.
# Pass --home after the filter to offer ~/ for browsing $HOME (stow).
# Return codes:
#   0  selected $HOME-relative path(s) printed to stdout
#   1  cancelled, bad args, or empty selection
#   2  no files matched the filter (caller may fall back to all)
#   3  user chose .. / - (go back to the package picker)
#   4  user chose ~/ (browse $HOME; only when --home was passed)
pick_files_from_packages() {
  local filter="${1:-all}"
  shift || true
  local with_home=0
  if [[ "${1:-}" == "--home" ]]; then
    with_home=1
    shift || true
  fi
  local packages=("$@")
  local package relative_path status selected cleaned
  local rows=()
  local header

  if [[ ${#packages[@]} -eq 0 ]]; then
    echo "No packages provided." >&2
    return 1
  fi

  # Build picker rows: path, package name, and current $HOME status.
  for package in "${packages[@]}"; do
    while IFS= read -r relative_path; do
      [[ -n "$relative_path" ]] || continue
      status="$(home_file_status "$relative_path")"
      case "$filter" in
        all) ;;
        stowed | real | absent | other)
          [[ "$status" == "$filter" ]] || continue
          ;;
        *)
          echo "Unknown file filter: $filter" >&2
          return 1
          ;;
      esac
      rows+=("$relative_path"$'\t'"$package"$'\t'"$status")
    done < <(list_package_files "$package")
  done

  # With --home, still show the picker so the user can open ~/ even if empty.
  if [[ ${#rows[@]} -eq 0 && $with_home -eq 0 ]]; then
    echo "No matching files for filter '$filter'." >&2
    return 2
  fi

  header='j/k move · Tab multi-select · - or .. back · / search · Enter confirm · path | package | status'
  if [[ $with_home -eq 1 ]]; then
    header='~/ browse $HOME · Tab multi-select · - or .. back · / search · path | package | status'
  fi

  # .. first; optional ~/ to browse home; then package files.
  # Only the path column is returned; package/status are display-only.
  selected="$(
    {
      printf '%s\n' "$BACK_ENTRY"
      if [[ $with_home -eq 1 ]]; then
        printf '%s\n' "$HOME_ENTRY"
      fi
      if [[ ${#rows[@]} -gt 0 ]]; then
        printf '%s\n' "${rows[@]}"
      fi
    } | fzf_vim --back --multi --delimiter $'\t' --with-nth=1,2,3 \
      --prompt 'File(s)> ' \
      --header "$header" \
      --height 80% \
    | cut -f1
  )" || true

  if [[ -z "${selected:-}" ]]; then
    return 1
  fi

  if selection_is_back "$selected"; then
    return 3
  fi

  if [[ $with_home -eq 1 ]] && selection_is_home_browser "$selected"; then
    return 4
  fi

  cleaned="$(strip_back_entries "$selected")"
  if [[ -z "$cleaned" ]]; then
    return 3
  fi

  printf '%s\n' "$cleaned"
}

# Interactive flow for stow/unstow with no CLI args.
# Sets global array `files` to the chosen $HOME-relative paths.
# For stow, also sets:
#   STOW_PACKAGE_MODE=fixed|create-inferred
#   STOW_PACKAGE=<name>   (when mode is fixed)
# After packages, stow can also open ~/ to browse $HOME.
# Unstow browses the package tree (Enter / . / Tab like the home browser).
# .. / - walks back through the picker stack.
ask_files_tui() {
  local mode="$1"
  local filter="all"
  local with_home_args=()
  local packages=()
  local selected_packages selected_files
  local pick_status=0
  local -a package_pick_opts=()

  STOW_PACKAGE_MODE=""
  STOW_PACKAGE=""

  case "$mode" in
    stow)
      filter="all"
      with_home_args=(--home)
      package_pick_opts=(--allow-new --single)
      ;;
    unstow) ;;
    *)
      echo "ask_files_tui: mode must be stow or unstow" >&2
      exit 1
      ;;
  esac

  while true; do
    packages=()
    set +e
    selected_packages="$(pick_packages ${package_pick_opts[@]+"${package_pick_opts[@]}"})"
    pick_status=$?
    set -e

    if [[ $pick_status -eq 3 ]]; then
      echo "Cancelled." >&2
      exit 1
    fi
    if [[ $pick_status -ne 0 || -z "${selected_packages:-}" ]]; then
      echo "No package selected." >&2
      exit 1
    fi

    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      packages+=("$line")
    done <<<"$selected_packages"

    # Stow: create a new package named via path inference, then browse $HOME.
    if [[ "$mode" == "stow" && "${packages[0]}" == "$NEW_PACKAGE_ENTRY" ]]; then
      STOW_PACKAGE_MODE="create-inferred"
      STOW_PACKAGE=""
      while true; do
        set +e
        selected_files="$(pick_home_paths)"
        pick_status=$?
        set -e

        if [[ $pick_status -eq 3 ]]; then
          break
        fi
        if [[ $pick_status -ne 0 || -z "${selected_files:-}" ]]; then
          echo "No file selected." >&2
          exit 1
        fi

        files=()
        while IFS= read -r line; do
          [[ -n "$line" ]] || continue
          files+=("$line")
        done <<<"$selected_files"
        return 0
      done
      continue
    fi

    if [[ "$mode" == "stow" ]]; then
      STOW_PACKAGE_MODE="fixed"
      STOW_PACKAGE="${packages[0]}"
    fi

    while true; do
      if [[ "$mode" == "unstow" ]]; then
        set +e
        selected_files="$(pick_package_paths "${packages[@]}")"
        pick_status=$?
        set -e

        if [[ $pick_status -eq 3 ]]; then
          break
        fi
        if [[ $pick_status -ne 0 || -z "${selected_files:-}" ]]; then
          echo "No file selected." >&2
          exit 1
        fi

        files=()
        while IFS= read -r line; do
          [[ -n "$line" ]] || continue
          files+=("$line")
        done <<<"$selected_files"
        return 0
      fi

      set +e
      selected_files="$(pick_files_from_packages "$filter" ${with_home_args[@]+"${with_home_args[@]}"} "${packages[@]}")"
      pick_status=$?
      set -e

      if [[ $pick_status -eq 3 ]]; then
        break
      fi

      # ~/ → browse $HOME; back returns to this file list.
      if [[ $pick_status -eq 4 ]]; then
        set +e
        selected_files="$(pick_home_paths)"
        pick_status=$?
        set -e

        if [[ $pick_status -eq 3 ]]; then
          continue
        fi
        if [[ $pick_status -ne 0 || -z "${selected_files:-}" ]]; then
          echo "No file selected." >&2
          exit 1
        fi
      elif [[ $pick_status -ne 0 || -z "${selected_files:-}" ]]; then
        echo "No file selected." >&2
        exit 1
      fi

      files=()
      while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        files+=("$line")
      done <<<"$selected_files"
      return 0
    done
  done
}
