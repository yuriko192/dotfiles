---
name: goal
description: >
  Set a goal that pi will pursue to completion. Use when the user invokes
  /goal or asks to keep working a single objective until it is done.
disable-model-invocation: true
---

# Goal

Pursue one objective until current evidence proves it is done. Pi has no CreateGoal tool. Do not invent goal files or APIs.

## Parse

Accept `/goal <objective>` or `/skill:goal <objective>`.

- Empty objective: show `Usage: /goal <objective>`
- No deadline, token budget, or turn budget. Continue until complete.
- A leading time limit (`30m`, `2h`) is not supported. Say that plainly, then keep the goal without folding the limit into the objective.
- "Every" is recurring work → `/skill:loop`, not this skill.

## Start

1. Restate the objective, including every explicit deliverable or required evidence.
2. Do the first concrete unit of work in this turn. Do not stop after planning.

## Guidelines

Keep the full objective intact across turns. If it cannot finish now, make real progress toward the requested end state. Do not redefine success around a smaller task.

Work from the current working tree and external state. Conversation memory can locate work; it is not proof.

If the work is multi-step, keep a short checklist in the reply and update it as steps complete. Skip planning theater for one-step work.

Each edit must make the requested final state more true. Useful-looking work that preserves a different end state is misaligned.

## Completion audit

Before calling the goal done, treat completion as unproven:

- Derive concrete requirements from the objective and any referenced files, plans, or instructions.
- For each requirement, inspect current evidence: files, command output, tests, PR state, runtime behavior.
- Tests and green checks count only after you confirm they cover that requirement.
- Uncertain or indirect evidence is not done. Keep working.

Do not mark the goal complete because you are stopping, or because nothing obvious is left. Mark it complete only when every requirement is evidenced in the current state.
