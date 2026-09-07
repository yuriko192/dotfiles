/**
 * Image Prompt
 *
 * Lets the agent accept images in the user prompt:
 * - Enables image input on the active model so pi does not strip attachments
 * - Turns image file paths in the prompt (including Ctrl+V paste paths) into
 *   multimodal ImageContent attachments
 * - Reads images from the system clipboard (wl-paste / xclip, or KDE Klipper)
 * - /image <path|clipboard> [message] — attach an image and send a prompt
 * - Ctrl+Shift+V — paste clipboard image into the editor as a file path
 *
 * Usage:
 *   Ctrl+Shift+V to paste a clipboard image, then type your question and submit
 *   /image clipboard What UI is this?
 *   /image ./screenshot.png What UI is this?
 *   Describe this: /tmp/pi-clipboard-….png
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";

const IMAGE_EXT = String.raw`png|jpe?g|gif|webp|bmp`;
const IMAGE_PATH_RE = new RegExp(
	String.raw`(?:^|\s)(@?(?:"([^"\n]+\.(?:${IMAGE_EXT}))"|'([^'\n]+\.(?:${IMAGE_EXT}))'|(\S+\.(?:${IMAGE_EXT}))))(?=\s|$)`,
	"gi",
);
const SUPPORTED_CLIPBOARD_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const CLIPBOARD_ALIASES = new Set(["clipboard", "clip", "cb"]);

type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

function ensureModelAcceptsImages(model: Model<any> | undefined): boolean {
	if (!model) return false;
	if (model.input.includes("image")) return true;
	model.input = [...model.input, "image"];
	return true;
}

function expandPath(filePath: string, cwd: string): string {
	let cleaned = filePath.trim();
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	if (
		(cleaned.startsWith('"') && cleaned.endsWith('"')) ||
		(cleaned.startsWith("'") && cleaned.endsWith("'"))
	) {
		cleaned = cleaned.slice(1, -1);
	}
	if (cleaned.startsWith("~/")) {
		cleaned = resolve(homedir(), cleaned.slice(2));
	} else if (cleaned === "~") {
		cleaned = homedir();
	} else if (!isAbsolute(cleaned)) {
		cleaned = resolve(cwd, cleaned);
	}
	return cleaned;
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function extensionForImageMimeType(mimeType: string): string {
	switch (baseMimeType(mimeType)) {
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "png";
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => ({ raw: entry, base: baseMimeType(entry) }));
	for (const preferred of SUPPORTED_CLIPBOARD_MIME_TYPES) {
		const match = normalized.find((entry) => entry.base === preferred);
		if (match) return match.raw;
	}
	const anyImage = normalized.find((entry) => entry.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function runCommand(
	command: string,
	args: string[],
	timeoutMs = 3000,
): { ok: boolean; stdout: Buffer } {
	const result = spawnSync(command, args, {
		timeout: timeoutMs,
		maxBuffer: 50 * 1024 * 1024,
		encoding: "buffer",
	});
	if (result.error || result.status !== 0) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}
	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(result.stdout ?? "");
	return { ok: true, stdout };
}

function readClipboardImageViaWlPaste(): ClipboardImage | null {
	const list = runCommand("wl-paste", ["--list-types"], 1000);
	if (!list.ok) return null;
	const types = list.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter(Boolean);
	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) return null;
	const data = runCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (!data.ok || data.stdout.length === 0) return null;
	return { bytes: data.stdout, mimeType: baseMimeType(selectedType) };
}

function readClipboardImageViaXclip(): ClipboardImage | null {
	const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], 1000);
	let candidateTypes: string[] = [];
	if (targets.ok) {
		candidateTypes = targets.stdout
			.toString("utf-8")
			.split(/\r?\n/)
			.map((entry) => entry.trim())
			.filter(Boolean);
	}
	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null;
	const tryTypes = preferred
		? [preferred, ...SUPPORTED_CLIPBOARD_MIME_TYPES]
		: [...SUPPORTED_CLIPBOARD_MIME_TYPES];
	for (const mimeType of tryTypes) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(mimeType) };
		}
	}
	return null;
}

/** Plasma Wayland often lacks wl-paste; Klipper stores clipboard items as files. */
function readClipboardImageViaKlipper(): ClipboardImage | null {
	const historyPath = join(homedir(), ".local/share/klipper/history3.sqlite");
	try {
		const database = new DatabaseSync(historyPath, { readOnly: true });
		try {
			const current = database
				.prepare(
					`SELECT uuid, mimetypes
					 FROM main
					 ORDER BY COALESCE(last_used_time, added_time) DESC
					 LIMIT 1`,
				)
				.get() as { uuid: string; mimetypes: string } | undefined;

			let entryUuid = current?.uuid;
			if (!current?.mimetypes?.toLowerCase().includes("image/")) {
				const latestImage = database
					.prepare(
						`SELECT uuid
						 FROM main
						 WHERE mimetypes LIKE '%image/%'
						 ORDER BY COALESCE(last_used_time, added_time) DESC
						 LIMIT 1`,
					)
					.get() as { uuid: string } | undefined;
				entryUuid = latestImage?.uuid;
			}
			if (!entryUuid) return null;

			const row = database
				.prepare(
					`SELECT mimetype, data_uuid
					 FROM aux
					 WHERE uuid = ? AND mimetype LIKE 'image/%'
					 ORDER BY CASE
					   WHEN mimetype = 'image/png' THEN 0
					   WHEN mimetype = 'image/jpeg' THEN 1
					   WHEN mimetype = 'image/webp' THEN 2
					   WHEN mimetype = 'image/gif' THEN 3
					   ELSE 4
					 END
					 LIMIT 1`,
				)
				.get(entryUuid) as { mimetype: string; data_uuid: string } | undefined;
			if (!row) return null;

			const filePath = join(
				homedir(),
				".local/share/klipper/data",
				entryUuid,
				row.data_uuid,
			);
			const bytes = readFileSync(filePath);
			if (bytes.length === 0) return null;
			return {
				bytes,
				mimeType: baseMimeType(row.mimetype),
			};
		} finally {
			database.close();
		}
	} catch {
		return null;
	}
}

async function readClipboardImage(): Promise<ClipboardImage | null> {
	const fromTools = readClipboardImageViaWlPaste() ?? readClipboardImageViaXclip();
	if (fromTools) return fromTools;
	return readClipboardImageViaKlipper();
}

function clipboardImageToContent(image: ClipboardImage): ImageContent {
	return {
		type: "image",
		mimeType: baseMimeType(image.mimeType),
		data: Buffer.from(image.bytes).toString("base64"),
	};
}

async function loadImage(filePath: string): Promise<ImageContent | null> {
	try {
		await access(filePath);
	} catch {
		return null;
	}
	const mimeType = await detectSupportedImageMimeTypeFromFile(filePath);
	if (!mimeType) return null;
	const bytes = await readFile(filePath);
	return {
		type: "image",
		mimeType,
		data: bytes.toString("base64"),
	};
}

interface ExtractResult {
	text: string;
	images: ImageContent[];
	paths: string[];
	missing: string[];
}

async function extractImagesFromText(text: string, cwd: string): Promise<ExtractResult> {
	const images: ImageContent[] = [];
	const paths: string[] = [];
	const missing: string[] = [];
	const seen = new Set<string>();
	const matches: Array<{ start: number; end: number; raw: string }> = [];

	IMAGE_PATH_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = IMAGE_PATH_RE.exec(text)) !== null) {
		const raw = match[2] ?? match[3] ?? match[4] ?? match[1] ?? "";
		if (!raw) continue;
		const full = match[0];
		const leadingWs = full.match(/^\s/)?.[0] ?? "";
		const start = match.index + leadingWs.length;
		const end = match.index + full.length;
		matches.push({ start, end, raw });
	}

	let out = text;
	for (let index = matches.length - 1; index >= 0; index--) {
		const item = matches[index]!;
		const absolutePath = expandPath(item.raw, cwd);
		if (seen.has(absolutePath)) {
			out = `${out.slice(0, item.start)}${out.slice(item.end)}`.replace(/  +/g, " ");
			continue;
		}
		seen.add(absolutePath);
		const image = await loadImage(absolutePath);
		if (!image) {
			missing.push(item.raw);
			continue;
		}
		images.unshift(image);
		paths.unshift(absolutePath);
		out = `${out.slice(0, item.start)}${out.slice(item.end)}`.replace(/  +/g, " ");
	}

	out = out.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();
	return { text: out, images, paths, missing };
}

function parseImageCommandArgs(args: string): { path: string; message: string } | null {
	const trimmed = args.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith('"')) {
		const end = trimmed.indexOf('"', 1);
		if (end === -1) return null;
		return {
			path: trimmed.slice(1, end),
			message: trimmed.slice(end + 1).trim(),
		};
	}
	if (trimmed.startsWith("'")) {
		const end = trimmed.indexOf("'", 1);
		if (end === -1) return null;
		return {
			path: trimmed.slice(1, end),
			message: trimmed.slice(end + 1).trim(),
		};
	}

	const space = trimmed.search(/\s/);
	if (space === -1) {
		return { path: trimmed, message: "" };
	}
	return {
		path: trimmed.slice(0, space),
		message: trimmed.slice(space + 1).trim(),
	};
}

async function sendWithImages(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	images: ImageContent[],
	message: string,
): Promise<void> {
	if (images.length === 0) {
		ctx.ui.notify("No image to send", "error");
		return;
	}
	if (!ensureModelAcceptsImages(ctx.model)) {
		ctx.ui.notify("No model selected", "error");
		return;
	}

	const prompt =
		message ||
		(images.length === 1 ? "What's in this image?" : "What is in these images?");
	const content: Array<{ type: "text"; text: string } | ImageContent> = [
		{ type: "text", text: prompt },
		...images,
	];

	if (ctx.isIdle()) {
		pi.sendUserMessage(content);
		return;
	}

	pi.sendUserMessage(content, { deliverAs: "followUp" });
	ctx.ui.notify("Image prompt queued as follow-up", "info");
}

async function sendWithImagePath(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	filePath: string,
	message: string,
): Promise<void> {
	const absolutePath = expandPath(filePath, ctx.cwd);
	const image = await loadImage(absolutePath);
	if (!image) {
		ctx.ui.notify(`Not a readable image: ${filePath}`, "error");
		return;
	}
	await sendWithImages(pi, ctx, [image], message);
}

async function pasteClipboardImageIntoEditor(ctx: ExtensionContext): Promise<void> {
	const clipboardImage = await readClipboardImage();
	if (!clipboardImage) {
		ctx.ui.notify(
			"No image in clipboard (copy an image, or install wl-clipboard)",
			"warning",
		);
		return;
	}

	const ext = extensionForImageMimeType(clipboardImage.mimeType);
	const filePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.${ext}`);
	await writeFile(filePath, Buffer.from(clipboardImage.bytes));

	const current = ctx.ui.getEditorText() ?? "";
	const needsSpace = current.length > 0 && !/\s$/.test(current);
	ctx.ui.setEditorText(`${current}${needsSpace ? " " : ""}${filePath}`);
	ctx.ui.notify("Clipboard image pasted into editor", "info");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ensureModelAcceptsImages(ctx.model);
	});

	pi.on("model_select", async (event) => {
		ensureModelAcceptsImages(event.model);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const extracted = await extractImagesFromText(event.text, ctx.cwd);
		const existing = event.images ?? [];
		const images = [...existing, ...extracted.images];

		if (extracted.images.length === 0) {
			if (extracted.missing.length > 0) {
				ctx.ui.notify(
					`Image path not found or unsupported: ${extracted.missing.join(", ")}`,
					"warning",
				);
			}
			return { action: "continue" };
		}

		if (!ensureModelAcceptsImages(ctx.model)) {
			ctx.ui.notify("No model selected; cannot send images", "error");
			return { action: "handled" };
		}

		const text =
			extracted.text ||
			(images.length === 1 ? "What's in this image?" : "What is in these images?");

		ctx.ui.notify(
			`Attached ${extracted.images.length} image${extracted.images.length === 1 ? "" : "s"}`,
			"info",
		);

		return { action: "transform", text, images };
	});

	pi.registerCommand("image", {
		description: "Attach an image from a path or clipboard (/image <path|clipboard> [message])",
		handler: async (args, ctx) => {
			const parsed = parseImageCommandArgs(args);
			if (!parsed) {
				ctx.ui.notify("Usage: /image <path|clipboard> [message]", "warning");
				return;
			}

			if (CLIPBOARD_ALIASES.has(parsed.path.toLowerCase())) {
				const clipboardImage = await readClipboardImage();
				if (!clipboardImage) {
					ctx.ui.notify(
						"No image in clipboard (copy an image, or install wl-clipboard)",
						"error",
					);
					return;
				}
				await sendWithImages(pi, ctx, [clipboardImageToContent(clipboardImage)], parsed.message);
				return;
			}

			await sendWithImagePath(pi, ctx, parsed.path, parsed.message);
		},
	});

	pi.registerShortcut("ctrl+shift+v", {
		description: "Paste clipboard image into the editor",
		handler: async (ctx) => {
			await pasteClipboardImageIntoEditor(ctx);
		},
	});
}
