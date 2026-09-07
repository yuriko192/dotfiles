---
name: statusline
description: >
  Configure a custom status line or footer in the pi TUI. Use when the user
  mentions status line, statusline, footer customization, or session context
  above or below the prompt.
---

# Pi Status Line

Pi has no `statusLine` command in settings.json (that is Cursor CLI). Status text lives in an extension via `ctx.ui.setStatus` or a full footer replacement via `ctx.ui.setFooter`.

When the user asks for a status line, write or update an extension. Follow `create-extension` for location and reload.

Read local docs: `docs/tui.md` (footer / `setStatus` / `setFooter`) and `examples/extensions/status-line.ts`, `custom-footer.ts`.

## Persistent status (keep the built-in footer)

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let turnCount = 0;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("session", ctx.ui.theme.fg("dim", "Ready"));
  });

  pi.on("turn_start", async (_event, ctx) => {
    turnCount++;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus("session", theme.fg("accent", "●") + theme.fg("dim", ` Turn ${turnCount}`));
  });

  pi.on("turn_end", async (_event, ctx) => {
    const theme = ctx.ui.theme;
    ctx.ui.setStatus("session", theme.fg("success", "✓") + theme.fg("dim", ` Turn ${turnCount} complete`));
  });
}
```

`setStatus(id, text)` is keyed. Use a stable `id` so later updates replace the same slot. Clear with `setStatus(id, "")` or the API's clear helper if you add one.

Good for mode indicators, turn counts, and short session context.

## Replace the footer

```typescript
pi.on("session_start", async (_event, ctx) => {
  ctx.ui.setFooter((tui, theme, footerData) => ({
    render(width) {
      const branch = footerData.getGitBranch() || "no git";
      const model = ctx.model?.id ?? "no model";
      return [`${theme.fg("dim", model)}  ${theme.fg("accent", branch)}`];
    },
    dispose: footerData.onBranchChange(() => tui.requestRender()),
  }));
});
```

`footerData` exposes `getGitBranch()`, `getExtensionStatuses()`, and change listeners. Restore the built-in footer with `ctx.ui.setFooter(undefined)`.

Prefer `setStatus` unless the user asked to replace the whole footer.

## Workflow

1. Read any existing status/footer extension so you do not duplicate it.
2. Add or update `~/.pi/agent/extensions/status-line.ts` (or a name they chose). In this repo: `pi/.pi/agent/extensions/`.
3. `/reload` or start a new session.
4. Confirm the footer shows the requested fields.
