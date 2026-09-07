---
name: create-extension
description: >
  Create pi extensions. Use when adding hooks around agent events, custom tools,
  commands, shortcuts, permission gates, or TUI behavior. This is the pi analog
  of Cursor hooks.
---

# Creating Pi Extensions

Pi has no `hooks.json`. Event automation is a TypeScript extension loaded by pi.

When the user asks for a hook, gate, or "run this before/after a tool", write an extension.

## Locations

| Scope | Path |
|-------|------|
| Global file | `~/.pi/agent/extensions/<name>.ts` |
| Global dir | `~/.pi/agent/extensions/<name>/index.ts` |
| Project file | `.pi/extensions/<name>.ts` |
| Project dir | `.pi/extensions/<name>/index.ts` |

In this dotfiles repo, global extensions belong under `pi/.pi/agent/extensions/`.

Auto-discovered extensions hot-reload with `/reload`. Quick test: `pi -e ./path-to-extension.ts`.

Read local docs before inventing APIs:

```bash
# docs live under $(npm root -g)/@earendil-works/pi-coding-agent/docs/extensions.md
```

## Minimum Shape

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // start resources here, not in the factory
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // clean up here
  });
}
```

- Keep one concern per extension.
- Do not start long-lived resources in the factory. Start them in `session_start`.
- Tool schemas use `typebox` (`import { Type } from "typebox"`).
- Register tools with `pi.registerTool()`, commands with `pi.registerCommand()`, shortcuts with `pi.registerShortcut()`.

## Cursor Hook → Pi Event

| Cursor hook | Pi event | Typical return |
|-------------|----------|----------------|
| `sessionStart` | `session_start` | — |
| `sessionEnd` | `session_shutdown` | — |
| `preToolUse` | `tool_call` | `{ block: true, reason }` or mutate `event.input` |
| `beforeShellExecution` | `tool_call` when `toolName === "bash"` | block or confirm |
| `postToolUse` / `afterFileEdit` | `tool_execution_end` / `tool_result` | inject follow-up via other events |
| `beforeSubmitPrompt` | `before_agent_start` | `{ message, systemPrompt }` |
| `stop` | `agent_settled` | — |
| `preCompact` | `session_before_compact` | `{ cancel: true }` or custom summary |

`tool_call` is the permission gate. `event.input` is mutable. Return `{ block: true, reason?: string, terminate?: boolean }` to deny.

## Common Patterns

### Gate dangerous bash

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return;
  const command = String(event.input.command ?? "");
  if (!/\brm\s+-rf?\b|\bsudo\b/.test(command)) return;
  if (!ctx.hasUI) return { block: true, reason: "Dangerous command blocked (no UI)" };
  const ok = await ctx.ui.confirm("Dangerous command", `Allow?\n\n${command}`);
  if (!ok) return { block: true, reason: "Blocked by user" };
});
```

### Custom tool

```typescript
import { Type } from "typebox";

pi.registerTool({
  name: "greet",
  label: "Greet",
  description: "Greet someone by name",
  parameters: Type.Object({
    name: Type.String({ description: "Name to greet" }),
  }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: {} };
  },
});
```

### Command

```typescript
pi.registerCommand("hello", {
  description: "Say hello",
  handler: async (args, ctx) => {
    ctx.ui.notify(`Hello ${args || "world"}!`, "info");
  },
});
```

Existing extensions in this package (`ask-user.ts`, `add-context.ts`, `modified-files.ts`) are the local style reference. Match their focus and TypeScript style.

## Workflow

1. Pick global vs project location.
2. Map the user's event to a pi event from the table above.
3. Write the extension. Preserve unrelated existing extensions.
4. Test with `pi -e ./file.ts` or place it in an auto-discovered path and `/reload`.
5. Watch startup output for extension errors.

## Security

Extensions run with the user's permissions. Do not install or execute untrusted extension code. Never commit credentials.
