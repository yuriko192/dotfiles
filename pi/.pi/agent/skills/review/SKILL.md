---
name: review
description: Review code changes with a bug-finding or security review.
disable-model-invocation: true
---

# Review

Ask the user which review to run. If `ask_user` is available, use it with exactly one question and these two options:

- `bugs`: Bug review (`/skill:review-bugs`)
- `security`: Security review (`/skill:review-security`)

If `ask_user` is not available, ask in the reply with the same two options.

After the user chooses, load and follow that skill once. Do not run both unless they asked for both.
