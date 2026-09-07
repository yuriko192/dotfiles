---
name: review-bugs
description: >
  Review local code changes for correctness bugs. Use when the user asks for a
  bug review, /review-bugs, /review-bugbot, or Bugbot-style findings.
---

# Review Bugs

Review the requested diff for real, exploitable-in-practice correctness bugs. Do not fix findings or rerun unless the user asks.

Pi has no Bugbot subagent. Do the review in this session.

## Diff scope

Default to **branch changes**: merge-base of the current branch against the repo default branch (`main` / `master` / whatever `gh repo view --json defaultBranchRef` or `git symbolic-ref refs/remotes/origin/HEAD` reports), including committed, staged, and unstaged changes.

Use **uncommitted changes** only when the user asks to review local, dirty, or not-yet-committed work.

If the user names a PR, URL, or branch, check that target out before reviewing:

1. Resolve the PR/branch to a local branch.
2. If a different branch is checked out and git refuses because of local changes, explain the blocker and stash only after they confirm.
3. Review only after the target is checked out.

Do not provide a custom base branch unless you know this branch was cut from something other than the repo default.

## How to get the diff

```bash
git rev-parse --show-toplevel
git status --short
git diff --merge-base "<default-branch>" HEAD
git diff HEAD
```

For uncommitted-only: `git diff` and `git diff --cached`. Skip review if the combined diff is empty — say there was no diff to review.

## What to look for

Prioritize bugs that would ship:

- Wrong conditionals, inverted booleans, off-by-one
- Nil / undefined dereference, missing error checks
- Race conditions, stale state, incorrect lock or channel use
- Broken control flow (early return, swallowed error, wrong retry)
- Incorrect API contracts, status codes, or data mutations
- Tests that cannot fail or assert the wrong thing

Skip style, naming, and speculative refactors unless they hide a real bug.

## Output

If there are no issues: one line, e.g. `Bug review found no bugs`.

If there are findings, print a compact markdown table sorted by severity (highest first):

| Severity | Location | Finding |
|----------|----------|---------|
| high | `file.ts:42` | What is wrong and why it bites |

Severity: `critical`, `high`, `medium`, `low`. Location is `file:line`.

Do not implement fixes unless the user asks.
