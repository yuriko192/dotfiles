import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { NineRouterConfig } from "./config.ts";
import { apiEndpoint } from "./config.ts";

export interface NineRouterCapabilities {
	vision?: boolean;
	reasoning?: boolean;
	thinkingFormat?: string | null;
	thinkingCanDisable?: boolean;
	contextWindow?: unknown;
	maxOutput?: unknown;
}

export interface NineRouterModelRaw {
	id: string;
	owned_by?: string;
	context_length?: unknown;
	max_completion_tokens?: unknown;
	capabilities?: NineRouterCapabilities;
	[key: string]: unknown;
}

export interface MappedNineRouterModel {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: {
		supportsStore: boolean;
		supportsDeveloperRole: boolean;
		supportsReasoningEffort: boolean;
		maxTokensField: "max_tokens";
		thinkingFormat: "openai";
	};
}

const REQUEST_TIMEOUT_MS = 15_000;
const STARTUP_TIMEOUT_MS = 5_000;
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 4_096;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const THINKING_LEVEL_MAPS: Record<string, Record<string, string | null>> = {
	openai: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" },
	"openai-max": { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	"claude-adaptive": { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" },
	"claude-budget": { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	deepseek: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
	kimi: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" },
	"gemini-level": { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	"gemini-budget": { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	qwen: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	hunyuan: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
	zai: { off: "none", minimal: null, low: "high", medium: "high", high: "high", xhigh: null, max: "max" },
	minimax: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" },
};

function cachePath(): string {
	const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(cacheHome, "pi", "9router-models.json");
}

function parsePositiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		const parsed = Number(value.trim());
		if (parsed > 0) return parsed;
	}
	return undefined;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", abort, { once: true });
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

function isCachedModel(value: unknown): value is NineRouterModelRaw {
	return typeof value === "object" && value !== null && typeof (value as NineRouterModelRaw).id === "string";
}

export function readModelCache(): NineRouterModelRaw[] | null {
	try {
		if (!existsSync(cachePath())) return null;
		const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as unknown;
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		const models = parsed.filter(isCachedModel);
		return models.length > 0 ? models : null;
	} catch {
		return null;
	}
}

export function writeModelCache(models: NineRouterModelRaw[]): void {
	if (models.length === 0) return;
	const path = cachePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(models)}\n`, { mode: 0o600 });
}

export async function fetchModels(
	config: NineRouterConfig,
	signal?: AbortSignal,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<NineRouterModelRaw[]> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

	const response = await fetchWithTimeout(
		`${apiEndpoint(config)}/models`,
		{ method: "GET", headers },
		signal,
		timeoutMs,
	);
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`9router returned ${response.status}: ${text || response.statusText}`);
	}

	const payload = (await response.json()) as { data?: NineRouterModelRaw[] };
	return (payload.data ?? []).filter((model) => typeof model?.id === "string" && model.id.trim());
}

export async function fetchModelsAtStartup(config: NineRouterConfig): Promise<NineRouterModelRaw[]> {
	return fetchModels(config, undefined, STARTUP_TIMEOUT_MS);
}

function thinkingLevelMap(
	format: string | null | undefined,
	canDisable: boolean | undefined,
): Record<string, string | null> | undefined {
	if (!format) return undefined;
	const mapped = THINKING_LEVEL_MAPS[format] ?? THINKING_LEVEL_MAPS.openai;
	if (canDisable === false) return { ...mapped, off: null };
	return mapped;
}

export function mapModel(raw: NineRouterModelRaw, enableReasoning: boolean): MappedNineRouterModel {
	const capabilities = raw.capabilities ?? {};
	const reasoning = enableReasoning && capabilities.reasoning === true;
	const contextWindow =
		parsePositiveInt(capabilities.contextWindow) ??
		parsePositiveInt(raw.context_length) ??
		FALLBACK_CONTEXT_WINDOW;
	const maxTokens = Math.min(
		parsePositiveInt(capabilities.maxOutput) ??
			parsePositiveInt(raw.max_completion_tokens) ??
			FALLBACK_MAX_TOKENS,
		contextWindow,
	);
	const name =
		raw.owned_by === "combo"
			? `combo ${raw.id}`
			: raw.owned_by === "cu" || raw.id.startsWith("cu/")
				? `${raw.id} (cursor, limited tools)`
				: raw.id;

	return {
		id: raw.id,
		name,
		reasoning,
		...(reasoning ? { thinkingLevelMap: thinkingLevelMap(capabilities.thinkingFormat, capabilities.thinkingCanDisable) } : {}),
		input: capabilities.vision ? ["text", "image"] : ["text"],
		cost: ZERO_COST,
		contextWindow,
		maxTokens,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: reasoning,
			maxTokensField: "max_tokens",
			thinkingFormat: "openai",
		},
	};
}

export function mapModels(raw: NineRouterModelRaw[], enableReasoning: boolean): MappedNineRouterModel[] {
	return raw.map((model) => mapModel(model, enableReasoning));
}
