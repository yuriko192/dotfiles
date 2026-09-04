/**
 * ask_user tool
 *
 * Lets the agent stop on an ambiguity and ask the user one question: pick a
 * numbered option, or use the bottom row to type their own suggestion.
 *
 * - TUI: bordered dialog, ↑/↓ (or 1-9) to select, enter to confirm, esc to skip.
 *   Selecting the bottom row swaps in a multi-line editor for the free-text answer.
 * - RPC / other dialog-capable modes: falls back to ctx.ui.select() + ctx.ui.input().
 * - No UI at all (print mode): tells the agent to state an assumption and continue.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	type EditorTheme,
	Editor,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_OPTIONS = 8;
const CUSTOM_ROW_LABEL = "Type your own suggestion";
const CUSTOM_ROW_DESCRIPTION = "Answer with your own words instead of picking above";

interface AskOption {
	label: string;
	description?: string;
}

type AnswerKind = "option" | "custom" | "skipped" | "unavailable";

interface AskDetails {
	question: string;
	options: string[];
	answer: string | null;
	kind: AnswerKind;
	/** 1-based index into `options`, set when kind === "option" */
	index?: number;
}

/** What the TUI dialog resolves with. */
interface DialogResult {
	answer: string;
	kind: "option" | "custom";
	index?: number;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short answer text, a few words" }),
	description: Type.Optional(
		Type.String({ description: "One-line trade-off or detail shown under the label" }),
	),
});

const AskParams = Type.Object({
	question: Type.String({
		description: "The single thing you need the user to decide, phrased so an option answers it",
	}),
	context: Type.Optional(
		Type.String({
			description: "Optional one-line note on why you are asking, shown under the question",
		}),
	),
	options: Type.Array(OptionSchema, {
		minItems: 1,
		maxItems: MAX_OPTIONS,
		description: `1-${MAX_OPTIONS} distinct, mutually exclusive answers. A final free-text row is appended for you.`,
	}),
});

/** Accept plain strings as well as {label, description}, trim, dedupe, cap length. */
function normalizeOptions(raw: unknown): AskOption[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const options: AskOption[] = [];

	for (const entry of raw) {
		const record = typeof entry === "object" && entry ? (entry as Record<string, unknown>) : undefined;
		const label =
			typeof entry === "string" ? entry : typeof record?.label === "string" ? record.label : undefined;
		if (!label) continue;

		const trimmed = label.trim();
		const dedupeKey = trimmed.toLowerCase();
		if (!trimmed || seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);

		const description = typeof record?.description === "string" ? record.description.trim() : "";
		options.push({ label: trimmed, ...(description ? { description } : {}) });
		if (options.length >= MAX_OPTIONS) break;
	}

	return options;
}

function toDetails(
	question: string,
	options: AskOption[],
	kind: AnswerKind,
	answer: string | null,
	index?: number,
): AskDetails {
	return { question, options: options.map((o) => o.label), answer, kind, index };
}

function answerForModel(details: AskDetails): string {
	const q = `Q: ${details.question}`;
	switch (details.kind) {
		case "option":
			return `${q}\nA: user picked option ${details.index}: ${details.answer}`;
		case "custom":
			return `${q}\nA: user answered in their own words: ${details.answer}`;
		case "skipped":
			return `${q}\nA: user skipped the question. Pick the option you think is best, state that assumption, and keep going.`;
		case "unavailable":
			return `${q}\nA: no interactive user is available (non-interactive session). State your assumption and keep going.`;
	}
}

/** Question + options, numbered, with the appended free-text row. */
function numberedOptions(options: AskOption[]): string[] {
	return [...options.map((o, i) => `${i + 1}. ${o.label}`), `${options.length + 1}. ${CUSTOM_ROW_LABEL}`];
}

/** Non-TUI fallback: native select dialog, then a text input for the bottom row. */
async function askViaDialogs(
	question: string,
	options: AskOption[],
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AskDetails> {
	const labels = numberedOptions(options);
	const choice = await ctx.ui.select(question, labels, { signal });

	if (!choice) return toDetails(question, options, "skipped", null);

	const index = labels.indexOf(choice) + 1;
	if (index <= options.length) return toDetails(question, options, "option", options[index - 1].label, index);

	// Bottom row: collect free text.
	const typed = await ctx.ui.input(question, "Your suggestion", { signal });
	const answer = typed?.trim();
	return answer
		? toDetails(question, options, "custom", answer)
		: toDetails(question, options, "skipped", null);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "ask user",
		description:
			"Ask the user one clarifying question with 1-8 options. They pick an option or type their own " +
			"suggestion in the bottom row. Use when requirements are ambiguous and guessing wastes work.",
		promptSnippet: "ask the user a clarifying question with options (they can type their own answer)",
		promptGuidelines: [
			"Use ask_user when a requirement is ambiguous and the options change what you would build; ask one question at a time.",
			"Give ask_user distinct, mutually exclusive, concrete options and put the likely-best one first; never ask about routine actions already covered elsewhere.",
			"If ask_user reports the user skipped the question or that no user is available, choose the best option, say which assumption you made, and continue without asking again.",
		],
		parameters: AskParams,
		executionMode: "sequential",

		prepareArguments(args) {
			const raw = (args ?? {}) as Record<string, unknown>;
			return {
				question: typeof raw.question === "string" ? raw.question : String(raw.question ?? ""),
				context: typeof raw.context === "string" && raw.context.trim() ? raw.context.trim() : undefined,
				options: normalizeOptions(raw.options),
			};
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const question = params.question.trim();
			const options = normalizeOptions(params.options);

			if (options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: ask_user needs at least one option with a label" }],
					details: toDetails(question, [], "unavailable", null),
					isError: true,
				};
			}

			if (ctx.mode === "tui") {
				const dialog = await ctx.ui.custom<DialogResult | null>((tui, theme, keybindings, done) => {
					const rows: AskOption[] = [...options, { label: CUSTOM_ROW_LABEL, description: CUSTOM_ROW_DESCRIPTION }];
					const customRowIndex = rows.length - 1;

					let cursor = 0;
					let editing = false;
					let cachedLines: string[] | undefined;
					let componentFocused = false;
					let settled = false;

					const editorTheme: EditorTheme = {
						borderColor: (s: string) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t: string) => theme.fg("accent", t),
							selectedText: (t: string) => theme.fg("accent", t),
							description: (t: string) => theme.fg("muted", t),
							scrollInfo: (t: string) => theme.fg("dim", t),
							noMatch: (t: string) => theme.fg("warning", t),
						},
					};
					const border = new DynamicBorder((str: string) => theme.fg("accent", str));
					const editor = new Editor(tui, editorTheme, { paddingX: 0 });
					editor.onSubmit = (value) => {
						const answer = value.trim();
						// Empty submit: keep the cursor in the field, esc is how you leave.
						if (!answer) return;
						finish({ answer, kind: "custom" });
					};

					const refresh = () => {
						cachedLines = undefined;
						tui.requestRender();
					};

					const finish = (result: DialogResult | null) => {
						if (settled) return;
						settled = true;
						done(result);
					};

					const onAbort = () => finish(null);
					signal?.addEventListener("abort", onAbort, { once: true });

					// Keep the child editor's cursor/IME positioning in sync with our focus state.
					const syncEditorFocus = () => {
						editor.focused = componentFocused && editing;
					};

					const enterEditor = () => {
						editing = true;
						syncEditorFocus();
						refresh();
					};

					// Keep the draft: escaping back to the options should not eat what was typed.
					const exitEditor = () => {
						editing = false;
						syncEditorFocus();
						refresh();
					};

					const selectRow = (index: number) => {
						if (index === customRowIndex) {
							enterEditor();
							return;
						}
						const option = rows[index];
						finish({ answer: option.label, kind: "option", index: index + 1 });
					};

					const component = {
						render(width: number) {
							if (cachedLines) return cachedLines;

							const lines: string[] = [];
							lines.push(...border.render(width));

							const wrapWithPrefix = (prefix: string, text: string) => {
								const prefixWidth = visibleWidth(prefix);
								if (prefixWidth >= width) {
									lines.push(...wrapTextWithAnsi(prefix + text, Math.max(1, width)));
									return;
								}
								const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
								const cont = " ".repeat(prefixWidth);
								wrapped.forEach((line, i) => lines.push(`${i === 0 ? prefix : cont}${line}`));
							};

							wrapWithPrefix(" ", theme.fg("text", theme.bold(question)));
							if (params.context) {
								wrapWithPrefix(" ", theme.fg("muted", params.context));
							}
							lines.push("");

							rows.forEach((row, i) => {
								const isCursor = i === cursor;
								const isCustom = i === customRowIndex;
								const prefix = isCursor ? theme.fg("accent", "> ") : "  ";
								const label = isCustom
									? `${i + 1}. ${row.label}${editing ? " ← editing" : ""}`
									: `${i + 1}. ${row.label}`;
								wrapWithPrefix(prefix, theme.fg(isCursor || (isCustom && editing) ? "accent" : "text", label));
								if (row.description) {
									wrapWithPrefix("     ", theme.fg("dim", row.description));
								}
							});

							if (editing) {
								lines.push("");
								wrapWithPrefix(" ", theme.fg("muted", "Your suggestion:"));
								for (const line of editor.render(Math.max(1, width - 2))) {
									lines.push(` ${line}`);
								}
							}

							lines.push("");
							wrapWithPrefix(
								" ",
								theme.fg(
									"dim",
									editing
										? "enter submit · esc back to options"
										: "↑↓ or 1-9 select · enter to answer · esc skip question",
								),
							);
							lines.push(...border.render(width));

							cachedLines = lines;
							return lines;
						},

						invalidate() {
							cachedLines = undefined;
							editor.invalidate();
						},

						handleInput(data: string) {
							if (editing) {
								if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
									exitEditor();
									return;
								}
								if (keybindings.matches(data, "tui.select.cancel")) {
									finish(null);
									return;
								}
								editor.handleInput(data);
								refresh();
								return;
							}

							if (keybindings.matches(data, "tui.select.up")) {
								cursor = Math.max(0, cursor - 1);
							} else if (keybindings.matches(data, "tui.select.down")) {
								cursor = Math.min(rows.length - 1, cursor + 1);
							} else if (keybindings.matches(data, "tui.select.confirm")) {
								selectRow(cursor);
							} else if (keybindings.matches(data, "tui.select.cancel")) {
								finish(null);
							} else if (/^[1-9]$/.test(data)) {
								const target = Number(data) - 1;
								if (target < rows.length) {
									cursor = target;
									selectRow(target);
								}
							} else {
								return;
							}
							refresh();
						},

						dispose() {
							signal?.removeEventListener("abort", onAbort);
						},
					};

					// Focusable: propagate focus to the embedded editor for IME cursor placement.
					Object.defineProperty(component, "focused", {
						get: () => componentFocused,
						set: (value: boolean) => {
							componentFocused = value;
							syncEditorFocus();
						},
						configurable: true,
					});

					return component;
				});

				const details: AskDetails = !dialog
					? toDetails(question, options, "skipped", null)
					: dialog.kind === "option"
						? toDetails(question, options, "option", dialog.answer, dialog.index)
						: toDetails(question, options, "custom", dialog.answer);
				return { content: [{ type: "text", text: answerForModel(details) }], details };
			}

			if (ctx.hasUI) {
				const details = await askViaDialogs(question, options, ctx, signal);
				return { content: [{ type: "text", text: answerForModel(details) }], details };
			}

			const details = toDetails(question, options, "unavailable", null);
			return { content: [{ type: "text", text: answerForModel(details) }], details };
		},

		renderCall(args, theme, _context) {
			const options = normalizeOptions(args.options);
			const lines = [theme.fg("toolTitle", theme.bold("ask user ")) + theme.fg("muted", args.question)];
			if (args.context) lines.push(theme.fg("dim", `  ${args.context}`));
			if (options.length) {
				lines.push(theme.fg("dim", `  ${numberedOptions(options).join(" · ")}`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.kind === "option") {
				return new Text(theme.fg("success", "✓ ") + theme.fg("accent", `${details.index}. ${details.answer}`), 0, 0);
			}
			if (details.kind === "custom") {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "own words: ") + theme.fg("accent", details.answer ?? ""),
					0,
					0,
				);
			}
			if (details.kind === "unavailable") {
				return new Text(theme.fg("warning", "no user to ask"), 0, 0);
			}
			return new Text(theme.fg("warning", "skipped — proceeding with best guess"), 0, 0);
		},
	});
}
