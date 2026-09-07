---
name: review-security
description: >
  Review local code changes for security issues. Use when the user asks for a
  security review or /review-security.
---

# Review Security

Review the requested diff for security issues that an attacker could use. Do not fix findings or rerun unless the user asks.

Pi has no Security Review subagent. Do the review in this session.

## Diff scope

Same rules as `review-bugs`:

- Default **branch changes** vs the repo default branch (committed + staged + unstaged).
- **Uncommitted changes** only when asked.
- If the user names a PR or branch, check it out first. Stash only after they confirm.

Skip review if the combined diff is empty — say there was no diff to review.

## What to look for

- Injection (SQL, command, template, LDAP) and unsafe deserialization
- Broken authn/authz, missing tenant checks, IDOR
- Secret or key leakage, tokens in logs, committed credentials
- Path traversal, arbitrary file read/write
- SSRF, XSS, CSRF where the change introduces it
- Insecure crypto, weak randomness for security decisions
- Overly broad CORS, cookie flags, or redirect handling

Report only issues grounded in the diff. Do not pad with generic checklist items that the change does not touch.

## Output

If there are no issues: one line, e.g. `Security review found no issues`.

If there are findings, print a compact markdown table sorted by severity (highest first):

| Severity | Location | Finding |
|----------|----------|---------|
| high | `file.ts:42` | What is exposed and how |

Severity: `critical`, `high`, `medium`, `low`. Location is `file:line`.

Do not implement fixes unless the user asks.
