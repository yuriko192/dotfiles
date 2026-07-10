/**
 * Add Context Extension
 *
 * Allows users to pick a file via an interactive file explorer with neovim-style
 * navigation, then select a specific section to add as context to the current
 * agent session. Supports adding multiple contexts per turn.
 *
 * Trigger: Ctrl+H in the chat window (or /add-context command)
 *
 * Navigation:
 *   File Explorer: h/- parent dir, j/↓ down, k/↑ up, l/enter open, ctrl+y confirm
 *   Line Picker:   j/↓ down, k/↑ up, v visual select, ctrl+y confirm, -:back, esc cancel
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Text,
	matchesKey,
	Key,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const WIDGET_ID = "add-context-list";

interface SessionMemory {
	lastFile: string | null;
	lastDir: string | null;
	lastLine: number;
	contexts: Array<{ file: string; startLine: number; endLine: number }>;
}

export default function addContextExtension(pi: ExtensionAPI) {
	let memory: SessionMemory = {
		lastFile: null,
		lastDir: null,
		lastLine: 1,
		contexts: [],
	};

	pi.on("session_start", async (_event, ctx) => {
		memory = { lastFile: null, lastDir: null, lastLine: 1, contexts: [] };

		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type === "custom" &&
				(entry as any).customType === "add-context-state"
			) {
				const data = (entry as any).data;
				if (data) {
					memory.lastFile = data.lastFile ?? null;
					memory.lastDir = data.lastDir ?? null;
					memory.lastLine = data.lastLine ?? 1;
				}
			}
		}

		updateContextWidget(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (memory.contexts.length > 0) {
			memory.contexts = [];
			updateContextWidget(ctx);
		}
	});

	// ─── Ctrl+H shortcut: primary trigger ────────────────────────────────────

	pi.registerShortcut("ctrl+h", {
		description: "Add file context to session",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			await addContextFlow(ctx);
		},
	});

	// ─── /add-context command: alternative entry point ───────────────────────

	pi.registerCommand("add-context", {
		description: "Pick a file and select a section to add as context (Ctrl+H)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("This command requires an interactive UI", "error");
				return;
			}

			if (args && args.trim()) {
				await addContextDirect(ctx, args.trim());
				return;
			}

			await addContextFlow(ctx);
		},
	});

	pi.registerCommand("list-context", {
		description: "List all added contexts in this session",
		handler: async (_args, ctx) => {
			if (memory.contexts.length === 0) {
				ctx.ui.notify("No contexts added yet", "info");
				return;
			}
			const list = memory.contexts
				.map((c, i) => {
					const loc =
						c.startLine === c.endLine
							? `${c.file}<${c.startLine}>`
							: `${c.file}<${c.startLine}>:<${c.endLine}>`;
					return `${i + 1}. ${loc}`;
				})
				.join("\n");
			ctx.ui.notify(`Contexts (${memory.contexts.length}):\n${list}`, "info");
		},
	});

	pi.registerCommand("clear-context", {
		description: "Clear all added contexts from the widget",
		handler: async (_args, ctx) => {
			memory.contexts = [];
			updateContextWidget(ctx);
			ctx.ui.notify("All contexts cleared", "info");
		},
	});

	// ─── Core flows ──────────────────────────────────────────────────────────

	/**
	 * Direct mode: /add-context file.ts 10-25
	 */
	async function addContextDirect(ctx: any, args: string) {
		const parts = args.split(/\s+/);
		const filePath = parts[0];
		const rangeArg = parts[1];

		const resolvedPath = path.resolve(ctx.cwd, filePath);
		if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
			ctx.ui.notify(`Not a valid file: ${filePath}`, "error");
			return;
		}

		let content: string;
		try {
			content = fs.readFileSync(resolvedPath, "utf-8");
		} catch (err: any) {
			ctx.ui.notify(`Cannot read file: ${err.message}`, "error");
			return;
		}

		const lines = content.split("\n");
		if (lines.length === 0) {
			ctx.ui.notify("File is empty", "warning");
			return;
		}

		const relativePath = path.relative(ctx.cwd, resolvedPath);
		const displayPath = relativePath.startsWith("..") ? resolvedPath : relativePath;

		if (!rangeArg) {
			ctx.ui.notify("Range required for direct mode (e.g. 10-25)", "error");
			return;
		}

		const parsed = parseRange(rangeArg, lines.length);
		if (!parsed) {
			ctx.ui.notify(`Invalid range: "${rangeArg}". Use LINE or START-END`, "error");
			return;
		}

		commitContext(ctx, displayPath, lines, parsed.start, parsed.end);
	}

	/**
	 * Interactive flow: file explorer → line picker
	 */
	async function addContextFlow(ctx: any) {
		let filePath: string | undefined;

		if (memory.lastFile) {
			const resolvedLast = path.resolve(ctx.cwd, memory.lastFile);
			if (fs.existsSync(resolvedLast)) {
				const choice = await ctx.ui.select("Open file:", [
					`📄 Last file: ${memory.lastFile} (line ${memory.lastLine})`,
					"📁 Browse files...",
				]);
				if (!choice) {
					return;
				}
				if (choice.startsWith("📄 Last file:")) {
					filePath = memory.lastFile;
				}
			}
		}

		if (!filePath) {
			const picked = await openFileExplorer(ctx, memory.lastDir || ctx.cwd);
			if (!picked) {
				return;
			}
			filePath = picked;
		}

		let resolvedPath = path.resolve(ctx.cwd, filePath);

		if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
			ctx.ui.notify(`Not a valid file: ${filePath}`, "error");
			return;
		}

		let content: string;
		try {
			content = fs.readFileSync(resolvedPath, "utf-8");
		} catch (err: any) {
			ctx.ui.notify(`Cannot read file: ${err.message}`, "error");
			return;
		}

		let lines = content.split("\n");
		if (lines.length === 0) {
			ctx.ui.notify("File is empty", "warning");
			return;
		}

		memory.lastDir = path.dirname(resolvedPath);
		let relativePath = path.relative(ctx.cwd, resolvedPath);
		let displayPath = relativePath.startsWith("..") ? resolvedPath : relativePath;

		const initialLine = memory.lastFile === displayPath ? memory.lastLine : 1;
		let range = await openLinePicker(ctx, displayPath, lines, initialLine);

		// Handle "back" — re-open file explorer, then line picker again
		while (range === "back") {
			const picked = await openFileExplorer(ctx, memory.lastDir || ctx.cwd);
			if (!picked) {
				return;
			}

			filePath = picked;
			resolvedPath = path.resolve(ctx.cwd, filePath);
			if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
				ctx.ui.notify(`Not a valid file: ${filePath}`, "error");
				return;
			}

			try {
				content = fs.readFileSync(resolvedPath, "utf-8");
			} catch (err: any) {
				ctx.ui.notify(`Cannot read file: ${err.message}`, "error");
				return;
			}

			lines = content.split("\n");
			if (lines.length === 0) {
				ctx.ui.notify("File is empty", "warning");
				return;
			}

			memory.lastDir = path.dirname(resolvedPath);
			relativePath = path.relative(ctx.cwd, resolvedPath);
			displayPath = relativePath.startsWith("..") ? resolvedPath : relativePath;

			const newInitial = memory.lastFile === displayPath ? memory.lastLine : 1;
			range = await openLinePicker(ctx, displayPath, lines, newInitial);
		}

		if (!range) {
			return;
		}

		commitContext(ctx, displayPath, lines, range.start, range.end);
	}

	/**
	 * Commit a context selection: persist, inject message, update widget.
	 */
	function commitContext(ctx: any, displayPath: string, lines: string[], startLine: number, endLine: number) {
		memory.lastFile = displayPath;
		memory.lastLine = endLine;
		memory.contexts.push({ file: displayPath, startLine, endLine });

		pi.appendEntry("add-context-state", {
			lastFile: memory.lastFile,
			lastDir: memory.lastDir,
			lastLine: memory.lastLine,
		});

		const selectedLines = lines.slice(startLine - 1, endLine);
		const selectedContent = selectedLines.join("\n");
		const location =
			startLine === endLine
				? `${displayPath}<${startLine}>`
				: `${displayPath}<${startLine}>:<${endLine}>`;

		pi.sendMessage(
			{
				customType: "add-context",
				content: `Context from ${location}:\n\`\`\`\n${selectedContent}\n\`\`\``,
				display: true,
				details: { file: displayPath, startLine, endLine },
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);

		updateContextWidget(ctx);

		const totalContexts = memory.contexts.length;
		ctx.ui.notify(
			`Added context: ${location} (${selectedLines.length} line${selectedLines.length > 1 ? "s" : ""}) ` +
				`[${totalContexts} total context${totalContexts > 1 ? "s" : ""} in session]`,
			"info",
		);
	}

	// ─── Widget ──────────────────────────────────────────────────────────────

	function updateContextWidget(ctx: any) {
		if (!ctx.hasUI) return;

		if (memory.contexts.length === 0) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		ctx.ui.setWidget(WIDGET_ID, (_tui: any, theme: any) => {
			const header = theme.fg("accent", `📎 Contexts (${memory.contexts.length}):`);
			const items = memory.contexts.map((c, i) => {
				const loc =
					c.startLine === c.endLine
						? `${c.file}<${c.startLine}>`
						: `${c.file}<${c.startLine}>:<${c.endLine}>`;
				return theme.fg("dim", `  ${i + 1}. `) + theme.fg("muted", loc);
			});
			const lines = [header, ...items];
			return { render: () => lines, invalidate: () => {} };
		});
	}

	// ─── File Explorer (neovim-style) ────────────────────────────────────────

	async function openFileExplorer(ctx: any, startDir: string): Promise<string | null> {
		let currentDir = startDir;
		if (!fs.existsSync(currentDir)) currentDir = ctx.cwd;

		while (true) {
			const entries = readDirectory(currentDir);
			const relativeCwd = path.relative(ctx.cwd, currentDir) || ".";

			interface Entry {
				name: string;
				isDirectory: boolean;
				display: string;
				size: number;
			}

			const items: Entry[] = [];

			const dirs = entries
				.filter((e) => e.isDirectory)
				.sort((a, b) => a.name.localeCompare(b.name));
			const files = entries
				.filter((e) => !e.isDirectory)
				.sort((a, b) => a.name.localeCompare(b.name));

			for (const dir of dirs) {
				items.push({ name: dir.name, isDirectory: true, display: `${getFileIcon(dir.name, true)} ${dir.name}/`, size: 0 });
			}
			for (const file of files) {
				items.push({ name: file.name, isDirectory: false, display: `${getFileIcon(file.name, false)} ${file.name}`, size: file.size });
			}

			const result = await ctx.ui.custom<string | null>(
				(tui: any, theme: any, _kb: any, done: (v: string | null) => void) => {
					let cursor = 0;
					let scrollOffset = 0;
					const maxVisible = 20;

					return {
						render(width: number): string[] {
							const out: string[] = [];
							const border = "─".repeat(Math.max(0, width - 2));

							out.push(truncateToWidth(theme.fg("accent", `┌${border}┐`), width));
							out.push(
								truncateToWidth(
									theme.fg("accent", theme.bold(" File Explorer")) +
										theme.fg("muted", `  ${relativeCwd}`),
									width,
								),
							);
							out.push(truncateToWidth(theme.fg("accent", `├${border}┤`), width));

							if (items.length === 0) {
								out.push(truncateToWidth(theme.fg("dim", "  (empty directory)"), width));
							} else {
								if (cursor < scrollOffset) scrollOffset = cursor;
								if (cursor >= scrollOffset + maxVisible) scrollOffset = cursor - maxVisible + 1;

								const visible = items.slice(scrollOffset, scrollOffset + maxVisible);
								for (let i = 0; i < visible.length; i++) {
									const idx = scrollOffset + i;
									const item = visible[i];
									const isSelected = idx === cursor;
									const prefix = isSelected ? "▸ " : "  ";
									const sizeStr = !item.isDirectory && item.size > 0 ? ` ${formatFileSize(item.size)}` : "";

									if (isSelected) {
										// Highlighted row with full-width background
										const content = `${prefix}${item.display}${sizeStr}`;
										const pad = " ".repeat(Math.max(0, width - visibleWidth(content)));
										out.push(truncateToWidth(theme.bg("selectedBg", theme.fg("accent", content + pad)), width));
									} else if (item.isDirectory) {
										// Icon already colored by getFileIcon, dim the name
										out.push(truncateToWidth(`${prefix}${item.display}`, width));
									} else {
										// Icon already colored by getFileIcon, white filename
										out.push(truncateToWidth(
											`${prefix}${item.display}` + (sizeStr ? theme.fg("dim", sizeStr) : ""),
											width,
										));
									}
								}

								if (items.length > maxVisible) {
									const info = `${scrollOffset + 1}-${Math.min(scrollOffset + maxVisible, items.length)} of ${items.length}`;
									out.push(truncateToWidth(theme.fg("dim", `  ${info}`), width));
								}
							}

							out.push(truncateToWidth(theme.fg("accent", `├${border}┤`), width));
							out.push(
								truncateToWidth(
									theme.fg("dim", " j/k:move  l/enter:open  h/-:parent  ctrl+y:pick file  esc:cancel"),
									width,
								),
							);
							out.push(truncateToWidth(theme.fg("accent", `└${border}┘`), width));

							return out;
						},

						invalidate() {},

						handleInput(data: string) {
							if (data === "j" || matchesKey(data, Key.down)) {
								if (cursor < items.length - 1) cursor++;
								tui.requestRender();
								return;
							}

							if (data === "k" || matchesKey(data, Key.up)) {
								if (cursor > 0) cursor--;
								tui.requestRender();
								return;
							}

							if (data === "l" || matchesKey(data, Key.enter)) {
								if (items.length === 0) return;
								const item = items[cursor];
								if (item.isDirectory) {
									done(`dir:${item.name}`);
								} else {
									done(`file:${item.name}`);
								}
								return;
							}

							if (data === "h" || data === "-") {
								done("..");
								return;
							}

							if (matchesKey(data, Key.ctrl("y"))) {
								if (items.length === 0) return;
								const item = items[cursor];
								if (!item.isDirectory) {
									done(`file:${item.name}`);
								} else {
									done(`dir:${item.name}`);
								}
								return;
							}

							if (matchesKey(data, Key.escape)) {
								done(null);
								return;
							}

							if (data === "g") {
								cursor = 0;
								tui.requestRender();
								return;
							}

							if (data === "G") {
								cursor = Math.max(0, items.length - 1);
								tui.requestRender();
								return;
							}
						},
					};
				},
			);

			if (result === null) return null;

			if (result === "..") {
				if (currentDir !== ctx.cwd) {
					currentDir = path.dirname(currentDir);
				}
				continue;
			}

			if (result.startsWith("dir:")) {
				currentDir = path.join(currentDir, result.slice(4));
				continue;
			}

			if (result.startsWith("file:")) {
				const fullPath = path.join(currentDir, result.slice(5));
				return path.relative(ctx.cwd, fullPath);
			}
		}
	}

	// ─── Line Picker (neovim-style with visual mode) ─────────────────────────

	async function openLinePicker(
		ctx: any,
		filePath: string,
		lines: string[],
		initialLine: number,
	): Promise<{ start: number; end: number } | "back" | null> {
		const totalLines = lines.length;
		const pad = String(totalLines).length;

		return ctx.ui.custom<{ start: number; end: number } | "back" | null>(
			(tui: any, theme: any, _kb: any, done: (v: { start: number; end: number } | "back" | null) => void) => {
				let cursor = Math.max(0, Math.min(initialLine - 1, totalLines - 1));
				let scrollOffset = Math.max(0, cursor - 10);
				let visualStart: number | null = null;
				const maxVisible = 25;

				return {
					render(width: number): string[] {
						const out: string[] = [];
						const border = "─".repeat(Math.max(0, width - 2));

						out.push(truncateToWidth(theme.fg("accent", `┌${border}┐`), width));

						const fileIcon = getFileIcon(filePath, false);
						const modeLabel = visualStart !== null
							? theme.fg("warning", " VISUAL ")
							: theme.fg("muted", " NORMAL ");
						out.push(
							truncateToWidth(
								theme.fg("accent", theme.bold(` ${fileIcon} Line Picker`)) +
									theme.fg("muted", `  ${filePath} (${totalLines} lines) `) +
									modeLabel,
								width,
							),
						);
						out.push(truncateToWidth(theme.fg("accent", `├${border}┤`), width));

						if (cursor < scrollOffset) scrollOffset = cursor;
						if (cursor >= scrollOffset + maxVisible) scrollOffset = cursor - maxVisible + 1;

						const visible = lines.slice(scrollOffset, scrollOffset + maxVisible);
						const lang = getLanguageFromPath(filePath) ?? undefined;

						for (let i = 0; i < visible.length; i++) {
							const idx = scrollOffset + i;
							const lineNum = String(idx + 1).padStart(pad, " ");
							const lineContent = visible[i];
							const isSelected = idx === cursor;

							let inVisual = false;
							if (visualStart !== null) {
								const vMin = Math.min(visualStart, cursor);
								const vMax = Math.max(visualStart, cursor);
								inVisual = idx >= vMin && idx <= vMax;
							}

							const maxContentWidth = Math.max(10, width - pad - 6);
							const rawContent = lineContent.length > maxContentWidth
								? lineContent.slice(0, maxContentWidth) + "…"
								: lineContent || " ";

							// Apply syntax highlighting
							const highlighted = lang
								? highlightCode(rawContent, lang, theme)
								: rawContent;

							let line: string;
							if (isSelected && inVisual) {
								line = theme.fg("accent", `▸ ${lineNum} │ `) + theme.bg("selectedBg", theme.fg("accent", rawContent));
							} else if (isSelected) {
								line = theme.fg("accent", `▸ ${lineNum} │ `) + highlighted;
							} else if (inVisual) {
								line = theme.fg("dim", `  ${lineNum} │ `) + theme.bg("selectedBg", theme.fg("text", rawContent));
							} else {
								line = theme.fg("dim", `  ${lineNum} │ `) + highlighted;
							}

							out.push(truncateToWidth(line, width));
						}

						if (totalLines > maxVisible) {
							const info = `${scrollOffset + 1}-${Math.min(scrollOffset + maxVisible, totalLines)} of ${totalLines}`;
							out.push(truncateToWidth(theme.fg("dim", `  ${info}`), width));
						}

						out.push(truncateToWidth(theme.fg("accent", `├${border}┤`), width));

						const helpNormal = " j/k:move  v:visual select  ctrl+y:pick line  -:back  g/G:top/bottom  esc:cancel";
						const helpVisual = " j/k:extend  ctrl+y:confirm selection  esc:cancel visual  g/G:top/bottom";
						out.push(
							truncateToWidth(
								theme.fg("dim", visualStart !== null ? helpVisual : helpNormal),
								width,
							),
						);
						out.push(truncateToWidth(theme.fg("accent", `└${border}┘`), width));

						return out;
					},

					invalidate() {},

					handleInput(data: string) {
						if (data === "j" || matchesKey(data, Key.down)) {
							if (cursor < totalLines - 1) cursor++;
							tui.requestRender();
							return;
						}

						if (data === "k" || matchesKey(data, Key.up)) {
							if (cursor > 0) cursor--;
							tui.requestRender();
							return;
						}

						if (data === "v") {
							if (visualStart !== null) {
								visualStart = null;
							} else {
								visualStart = cursor;
							}
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.ctrl("y")) || matchesKey(data, Key.enter)) {
							if (visualStart !== null) {
								const start = Math.min(visualStart, cursor) + 1;
								const end = Math.max(visualStart, cursor) + 1;
								done({ start, end });
							} else {
								done({ start: cursor + 1, end: cursor + 1 });
							}
							return;
						}

						if (matchesKey(data, Key.escape)) {
							if (visualStart !== null) {
								visualStart = null;
								tui.requestRender();
							} else {
								done(null);
							}
							return;
						}

						// -: go back to file explorer
						if (data === "-") {
							if (visualStart !== null) {
								visualStart = null;
								tui.requestRender();
							} else {
								done("back");
							}
							return;
						}

						if (data === "g") {
							cursor = 0;
							tui.requestRender();
							return;
						}

						if (data === "G") {
							cursor = totalLines - 1;
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.ctrl("d"))) {
							cursor = Math.min(totalLines - 1, cursor + Math.floor(maxVisible / 2));
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.ctrl("u"))) {
							cursor = Math.max(0, cursor - Math.floor(maxVisible / 2));
							tui.requestRender();
							return;
						}
					},
				};
			},
		);
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface DirEntry {
	name: string;
	isDirectory: boolean;
	size: number;
}

function readDirectory(dirPath: string): DirEntry[] {
	try {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });
		return entries
			.filter(
				(e) =>
					!e.name.startsWith(".") &&
					e.name !== "node_modules" &&
					e.name !== "vendor",
			)
			.map((e) => {
				let size = 0;
				if (e.isFile()) {
					try {
						size = fs.statSync(path.join(dirPath, e.name)).size;
					} catch {}
				}
				return { name: e.name, isDirectory: e.isDirectory(), size };
			});
	} catch {
		return [];
	}
}

function formatFileSize(bytes: number): string {
	if (bytes === 0) return "";
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function parseRange(
	input: string,
	maxLine: number,
): { start: number; end: number } | null {
	const singleMatch = input.match(/^(\d+)$/);
	if (singleMatch) {
		const line = parseInt(singleMatch[1], 10);
		if (line < 1 || line > maxLine) return null;
		return { start: line, end: line };
	}

	const rangeMatch = input.match(/^(\d+)[-:](\d+)$/);
	if (rangeMatch) {
		const start = parseInt(rangeMatch[1], 10);
		const end = parseInt(rangeMatch[2], 10);
		if (start < 1 || end < 1 || start > maxLine || end > maxLine || start > end) return null;
		return { start, end };
	}

	return null;
}

// ─── Tokyonight colors (storm/night palette) ────────────────────────────────
// Matching MiniIcons highlight groups to tokyonight hex colors
const ICON_COLORS = {
	grey:   "\x1b[38;2;192;202;245m", // #c0caf5 (fg)
	purple: "\x1b[38;2;157;124;216m", // #9d7cd8
	blue:   "\x1b[38;2;122;162;247m", // #7aa2f7
	azure:  "\x1b[38;2;42;195;222m",  // #2ac3de
	cyan:   "\x1b[38;2;26;188;156m",  // #1abc9c
	green:  "\x1b[38;2;158;206;106m", // #9ece6a
	yellow: "\x1b[38;2;224;175;104m", // #e0af68
	orange: "\x1b[38;2;255;158;100m", // #ff9e64
	red:    "\x1b[38;2;247;118;142m", // #f7768e
	reset:  "\x1b[0m",
} as const;

type IconColor = keyof Omit<typeof ICON_COLORS, "reset">;

function colorIcon(glyph: string, color: IconColor): string {
	return `${ICON_COLORS[color]}${glyph}${ICON_COLORS.reset}`;
}

// ─── File Icons (mini.icons glyphs + tokyonight colors) ──────────────────────

interface IconDef {
	glyph: string;
	hl: IconColor;
}

// Directory icons from mini.icons
const DIR_ICONS: Record<string, IconDef> = {
	".git":         { glyph: "", hl: "orange" },
	".github":      { glyph: "", hl: "azure" },
	".config":      { glyph: "󱁿", hl: "cyan" },
	"node_modules": { glyph: "", hl: "green" },
	"src":          { glyph: "󰴉", hl: "purple" },
	"test":         { glyph: "󱞊", hl: "blue" },
	"tests":        { glyph: "󱞊", hl: "blue" },
	"build":        { glyph: "󱧼", hl: "grey" },
	"dist":         { glyph: "󱧼", hl: "grey" },
	"bin":          { glyph: "󱧺", hl: "yellow" },
	"lib":          { glyph: "󰲂", hl: "yellow" },
	"doc":          { glyph: "󱂷", hl: "purple" },
	"docs":         { glyph: "󱂷", hl: "purple" },
	"cmd":          { glyph: "󱧺", hl: "yellow" },
	"internal":     { glyph: "󰴉", hl: "purple" },
	"pkg":          { glyph: "󰴉", hl: "purple" },
	"vendor":       { glyph: "󰉗", hl: "yellow" },
	"config":       { glyph: "󱁿", hl: "cyan" },
	"migrations":   { glyph: "󰆼", hl: "grey" },
	"scripts":      { glyph: "󱧺", hl: "yellow" },
};

const DEFAULT_DIR_ICON: IconDef = { glyph: "󰉋", hl: "azure" };

// Extension → filetype icon from mini.icons
const EXT_ICONS: Record<string, IconDef> = {
	// Languages
	".go":    { glyph: "󰟓", hl: "azure" },
	".ts":    { glyph: "󰛦", hl: "azure" },
	".tsx":   { glyph: "", hl: "blue" },
	".js":    { glyph: "󰌞", hl: "yellow" },
	".jsx":   { glyph: "", hl: "azure" },
	".py":    { glyph: "󰌠", hl: "yellow" },
	".rs":    { glyph: "󱘗", hl: "orange" },
	".rb":    { glyph: "󰴭", hl: "red" },
	".java":  { glyph: "󰬷", hl: "orange" },
	".kt":    { glyph: "󱈙", hl: "blue" },
	".swift": { glyph: "󰛥", hl: "orange" },
	".c":     { glyph: "󰙱", hl: "blue" },
	".cpp":   { glyph: "󰙲", hl: "azure" },
	".h":     { glyph: "󰫵", hl: "purple" },
	".hpp":   { glyph: "󰙲", hl: "azure" },
	".cs":    { glyph: "󰌛", hl: "green" },
	".php":   { glyph: "󰌟", hl: "purple" },
	".lua":   { glyph: "󰢱", hl: "azure" },
	".vim":   { glyph: "", hl: "green" },
	".sh":    { glyph: "", hl: "grey" },
	".bash":  { glyph: "", hl: "green" },
	".zsh":   { glyph: "", hl: "green" },
	".fish":  { glyph: "", hl: "green" },
	".pl":    { glyph: "", hl: "azure" },
	".r":     { glyph: "󰟔", hl: "blue" },
	".scala": { glyph: "", hl: "red" },
	".zig":   { glyph: "", hl: "orange" },
	".dart":  { glyph: "", hl: "blue" },
	".ex":    { glyph: "", hl: "purple" },
	".exs":   { glyph: "", hl: "purple" },
	".erl":   { glyph: "", hl: "red" },
	".hs":    { glyph: "󰲒", hl: "purple" },
	".clj":   { glyph: "", hl: "green" },

	// Web
	".html":   { glyph: "󰌝", hl: "orange" },
	".htm":    { glyph: "󰌝", hl: "orange" },
	".css":    { glyph: "󰌜", hl: "azure" },
	".scss":   { glyph: "󰟬", hl: "red" },
	".sass":   { glyph: "󰟬", hl: "red" },
	".less":   { glyph: "󰌜", hl: "azure" },
	".vue":    { glyph: "󰡄", hl: "green" },
	".svelte": { glyph: "", hl: "orange" },

	// Data / Config
	".json":    { glyph: "󰘦", hl: "yellow" },
	".yaml":    { glyph: "", hl: "purple" },
	".yml":     { glyph: "", hl: "purple" },
	".toml":    { glyph: "", hl: "orange" },
	".xml":     { glyph: "󰗀", hl: "orange" },
	".csv":     { glyph: "", hl: "green" },
	".sql":     { glyph: "󰆼", hl: "grey" },
	".graphql": { glyph: "󰡷", hl: "red" },
	".proto":   { glyph: "", hl: "red" },
	".env":     { glyph: "󰒓", hl: "yellow" },

	// Docs
	".md":   { glyph: "󰍔", hl: "grey" },
	".mdx":  { glyph: "󰍔", hl: "grey" },
	".txt":  { glyph: "󰈔", hl: "grey" },
	".pdf":  { glyph: "󱎒", hl: "red" },
	".doc":  { glyph: "󱎒", hl: "azure" },
	".docx": { glyph: "󱎒", hl: "azure" },

	// DevOps / Infra
	".dockerfile": { glyph: "󰡨", hl: "blue" },
	".tf":         { glyph: "󱁢", hl: "blue" },
	".hcl":        { glyph: "󱁢", hl: "blue" },
	".nix":        { glyph: "", hl: "azure" },

	// Build / Package
	".lock": { glyph: "󰌾", hl: "grey" },
	".mod":  { glyph: "󰟓", hl: "azure" },
	".sum":  { glyph: "󰟓", hl: "azure" },

	// Images
	".png":  { glyph: "󰸭", hl: "purple" },
	".jpg":  { glyph: "󰈥", hl: "orange" },
	".jpeg": { glyph: "󰈥", hl: "orange" },
	".gif":  { glyph: "󰵸", hl: "azure" },
	".svg":  { glyph: "󰈟", hl: "yellow" },
	".ico":  { glyph: "󰈟", hl: "yellow" },
	".webp": { glyph: "󰈟", hl: "blue" },

	// Archives
	".zip": { glyph: "󰗄", hl: "azure" },
	".tar": { glyph: "󰗄", hl: "cyan" },
	".gz":  { glyph: "󰗄", hl: "grey" },
	".bz2": { glyph: "󰗄", hl: "orange" },

	// Git
	".gitignore":  { glyph: "󰊢", hl: "purple" },
	".gitmodules": { glyph: "󰊢", hl: "orange" },
};

// Special filename icons
const NAME_ICONS: Record<string, IconDef> = {
	"Dockerfile":     { glyph: "󰡨", hl: "blue" },
	"Makefile":       { glyph: "󱁤", hl: "grey" },
	"Rakefile":       { glyph: "󰴭", hl: "red" },
	"Gemfile":        { glyph: "󰴭", hl: "red" },
	"Cargo.toml":     { glyph: "󱘗", hl: "orange" },
	"go.mod":         { glyph: "󰟓", hl: "azure" },
	"go.sum":         { glyph: "󰟓", hl: "azure" },
	"package.json":   { glyph: "󰘦", hl: "yellow" },
	"tsconfig.json":  { glyph: "󰛦", hl: "azure" },
	".gitignore":     { glyph: "󰊢", hl: "purple" },
	".dockerignore":  { glyph: "󰡨", hl: "blue" },
	"LICENSE":        { glyph: "󰿃", hl: "yellow" },
	"README.md":      { glyph: "󰍔", hl: "grey" },
	"CHANGELOG":      { glyph: "󰉻", hl: "blue" },
	"CHANGELOG.md":   { glyph: "󰉻", hl: "blue" },
	"AGENTS.md":      { glyph: "󰍔", hl: "azure" },
};

const DEFAULT_FILE_ICON: IconDef = { glyph: "󰈔", hl: "grey" };

function getFileIcon(filename: string, isDirectory: boolean): string {
	if (isDirectory) {
		const dirDef = DIR_ICONS[filename] ?? DEFAULT_DIR_ICON;
		return colorIcon(dirDef.glyph, dirDef.hl);
	}

	// Check exact filename match first
	const nameDef = NAME_ICONS[filename];
	if (nameDef) return colorIcon(nameDef.glyph, nameDef.hl);

	// Check by extension
	const ext = path.extname(filename).toLowerCase();
	const extDef = ext ? EXT_ICONS[ext] : undefined;
	if (extDef) return colorIcon(extDef.glyph, extDef.hl);

	return colorIcon(DEFAULT_FILE_ICON.glyph, DEFAULT_FILE_ICON.hl);
}
