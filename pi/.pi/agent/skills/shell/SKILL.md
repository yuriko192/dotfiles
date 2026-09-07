---
name: shell
description: >
  Runs the rest of a /shell or /skill:shell request as a literal shell command.
  Use only when the user explicitly invokes /shell or /skill:shell and wants the
  following text executed directly in the terminal.
disable-model-invocation: true
---

# Run Shell Commands

Use this skill only when the user explicitly invokes `/shell` or `/skill:shell`.

## Behavior

1. Treat all user text after the invocation as the literal shell command to run.
2. Execute that command immediately with the `bash` tool.
3. Do not rewrite, explain, or "improve" the command before running it.
4. Do not inspect the repository first unless the command itself requires repository context.
5. If the user invokes the command with no following text, ask which command to run.

## Response

- Run the command first.
- Then briefly report the exit status and any important stdout or stderr.
