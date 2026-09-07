---
name: loop
description: >
  Run a prompt or skill in this session on a recurring interval (e.g. /loop 5m
  /skill:review-bugs). Use when the user wants periodic checks until they stop.
---

# Loop

Run `/loop` or `/skill:loop` on a recurring interval. Pi has no Cursor subscription timer. Stay in this session and wake with `bash` `sleep`.

## Parse

Accept `/loop [interval] <prompt>`.

- Leading interval: `5m /skill:foo`, `30s check status`, `2h run report`
- Trailing interval: `check deploy every 5m`
- No interval: pick a sensible delay from the work (default 60s) and say what you picked
- Empty prompt: show `Usage: /loop [interval] <prompt>`

Intervals: `30s`, `5m`, `2h`, `1d`. Convert unit words to seconds for `sleep`.

## Fixed schedule

1. Run the prompt once immediately.
2. `bash` `sleep <seconds>` (blocking).
3. Run the prompt again.
4. Repeat until the user says stop, or a hard failure makes another tick useless.

Do not start a detached `while true` background loop. Pi will not wake from background stdout the way Cursor does. A blocking `sleep` between ticks is the supported mechanism.

## Dynamic schedule

When the user wants self-pacing:

1. Run the prompt now.
2. Decide the next wait from what you observed (deploy still running → wait longer; file just changed → wait shorter).
3. If the next run is gated on an event, poll with a short `sleep` and a cheap check (`git rev-parse`, `tail`, `gh run view`) instead of a long blind sleep.
4. Re-arm the next `sleep` at the end of each tick.

## Stop

Stop when the user says stop, cancel, or "enough". Do not start another sleep. Confirm that the loop has stopped and why.

If `sleep` is interrupted, treat that as stop unless the user asked to continue.

## Guidance

- Title sleep commands as `Loop <schedule>: <prompt>`.
- Keep tick output short after the first run: what changed.
- Do not nest a second loop.
- Recurring "every N" work belongs here. One-shot long objectives belong to `/skill:goal`.
