import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  let modifiedFiles: Map<string, { action: string; count: number }> = new Map();

  // Reconstruct state from session on start/reload
  pi.on("session_start", async (_event, ctx) => {
    modifiedFiles = new Map();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        const toolName = entry.message.toolName;
        if (toolName === "write" || toolName === "edit") {
          const path = entry.message.details?.path;
          if (path) {
            trackFile(path, toolName);
          }
        }
      }
    }
  });

  function trackFile(path: string, action: string) {
    const existing = modifiedFiles.get(path);
    if (existing) {
      existing.count++;
      existing.action = action;
    } else {
      modifiedFiles.set(path, { action, count: 1 });
    }
  }

  // Track file modifications from tool calls
  pi.on("tool_call", async (event, _ctx) => {
    if (isToolCallEventType("write", event)) {
      trackFile(event.input.path, "write");
    } else if (isToolCallEventType("edit", event)) {
      trackFile(event.input.path, "edit");
    }
  });

  // Show modified files at the end of each agent response
  pi.on("agent_end", async (_event, ctx) => {
    if (modifiedFiles.size === 0) return;
    ctx.ui.notify(formatModifiedFiles(), "info");
  });

  function formatModifiedFiles(): string {
    const lines = [`📝 Modified files (${modifiedFiles.size}):`];
    for (const [path, info] of modifiedFiles) {
      const badge = info.action === "write" ? "W" : "E";
      const times = info.count > 1 ? ` (×${info.count})` : "";
      lines.push(`  [${badge}] ${path}${times}`);
    }
    return lines.join("\n");
  }

  // File picker shortcut - Ctrl+J opens the picker
  pi.registerShortcut("ctrl+j", {
    description: "Open modified files picker",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;
      if (modifiedFiles.size === 0) {
        ctx.ui.notify("No modified files in this session.", "info");
        return;
      }

      const files = Array.from(modifiedFiles.entries()).map(([path, info]) => ({
        path,
        action: info.action,
        count: info.count,
      }));

      const result = await ctx.ui.custom<string | null>(
        (tui, theme, _keybindings, done) => {
          let selected = 0;
          const maxVisible = Math.min(files.length, 15);

          const container = new Container();

          function buildUI() {
            // Clear and rebuild
            while ((container as any).children?.length > 0) {
              container.removeChild((container as any).children[0]);
            }

            container.addChild(
              new DynamicBorder((s: string) => theme.fg("accent", s))
            );
            container.addChild(
              new Text(
                theme.fg("accent", theme.bold(`📝 Modified Files (${files.length})`)),
                1,
                0
              )
            );
            container.addChild(new Text("", 0, 0)); // spacer line

            for (let i = 0; i < files.length; i++) {
              const file = files[i];
              const badge = file.action === "write" ? "W" : "E";
              const times = file.count > 1 ? ` (×${file.count})` : "";
              const prefix = i === selected ? "❯ " : "  ";
              const label = `${prefix}[${badge}] ${file.path}${times}`;

              if (i === selected) {
                container.addChild(
                  new Text(theme.fg("accent", label), 1, 0)
                );
              } else {
                container.addChild(new Text(label, 1, 0));
              }
            }

            container.addChild(new Text("", 0, 0)); // spacer line
            container.addChild(
              new Text(
                theme.fg(
                  "dim",
                  "ctrl+k ↑ • ctrl+j ↓ • enter select • esc cancel"
                ),
                1,
                0
              )
            );
            container.addChild(
              new DynamicBorder((s: string) => theme.fg("accent", s))
            );
          }

          buildUI();

          return {
            render(width: number): string[] {
              return container.render(width);
            },
            invalidate() {
              container.invalidate();
            },
            handleInput(data: string) {
              if (
                matchesKey(data, Key.ctrl("j")) ||
                matchesKey(data, Key.down)
              ) {
                if (selected < files.length - 1) {
                  selected++;
                  buildUI();
                  tui.requestRender();
                }
              } else if (
                matchesKey(data, Key.ctrl("k")) ||
                matchesKey(data, Key.up)
              ) {
                if (selected > 0) {
                  selected--;
                  buildUI();
                  tui.requestRender();
                }
              } else if (matchesKey(data, Key.enter)) {
                done(files[selected].path);
              } else if (matchesKey(data, Key.escape)) {
                done(null);
              }
            },
          };
        },
        { overlay: true }
      );

      if (result) {
        // Insert the selected file path into the editor
        ctx.ui.setEditorText(result);
      }
    },
  });

  // Also keep the command for manual use
  pi.registerCommand("modified", {
    description: "Show files modified in this session",
    handler: async (_args, ctx) => {
      if (modifiedFiles.size === 0) {
        ctx.ui.notify("No files modified in this session.", "info");
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify(formatModifiedFiles(), "info");
        return;
      }

      const files = Array.from(modifiedFiles.entries()).map(([path, info]) => ({
        path,
        action: info.action,
        count: info.count,
      }));

      const result = await ctx.ui.custom<string | null>(
        (tui, theme, _keybindings, done) => {
          let selected = 0;
          const container = new Container();

          function buildUI() {
            while ((container as any).children?.length > 0) {
              container.removeChild((container as any).children[0]);
            }

            container.addChild(
              new DynamicBorder((s: string) => theme.fg("accent", s))
            );
            container.addChild(
              new Text(
                theme.fg("accent", theme.bold(`📝 Modified Files (${files.length})`)),
                1,
                0
              )
            );
            container.addChild(new Text("", 0, 0));

            for (let i = 0; i < files.length; i++) {
              const file = files[i];
              const badge = file.action === "write" ? "W" : "E";
              const times = file.count > 1 ? ` (×${file.count})` : "";
              const prefix = i === selected ? "❯ " : "  ";
              const label = `${prefix}[${badge}] ${file.path}${times}`;

              if (i === selected) {
                container.addChild(
                  new Text(theme.fg("accent", label), 1, 0)
                );
              } else {
                container.addChild(new Text(label, 1, 0));
              }
            }

            container.addChild(new Text("", 0, 0));
            container.addChild(
              new Text(
                theme.fg(
                  "dim",
                  "ctrl+k ↑ • ctrl+j ↓ • enter select • esc cancel"
                ),
                1,
                0
              )
            );
            container.addChild(
              new DynamicBorder((s: string) => theme.fg("accent", s))
            );
          }

          buildUI();

          return {
            render(width: number): string[] {
              return container.render(width);
            },
            invalidate() {
              container.invalidate();
            },
            handleInput(data: string) {
              if (
                matchesKey(data, Key.ctrl("j")) ||
                matchesKey(data, Key.down)
              ) {
                if (selected < files.length - 1) {
                  selected++;
                  buildUI();
                  tui.requestRender();
                }
              } else if (
                matchesKey(data, Key.ctrl("k")) ||
                matchesKey(data, Key.up)
              ) {
                if (selected > 0) {
                  selected--;
                  buildUI();
                  tui.requestRender();
                }
              } else if (matchesKey(data, Key.enter)) {
                done(files[selected].path);
              } else if (matchesKey(data, Key.escape)) {
                done(null);
              }
            },
          };
        },
        { overlay: true }
      );

      if (result) {
        ctx.ui.setEditorText(result);
      }
    },
  });
}
