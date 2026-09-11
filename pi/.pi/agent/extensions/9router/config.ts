import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface NineRouterConfig {
	baseUrl: string;
	apiKey: string | undefined;
	enableReasoning: boolean;
}

const DEFAULT_BASE_URL = "http://localhost:20128";
const CONFIG_VERSION = 1;

function envFirst(...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = process.env[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
	if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
	return undefined;
}

export function configPath(): string {
	return join(getAgentDir(), "9router-config.json");
}

/** Strip trailing slashes and a trailing `/v1` so callers can pass either form. */
export function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function apiEndpoint(config: NineRouterConfig): string {
	return `${config.baseUrl}/v1`;
}

export function maskApiKey(key: string | undefined): string {
	if (!key) return "(not set)";
	if (key.length <= 8) return "●".repeat(key.length);
	return `${key.slice(0, 4)}${"●".repeat(key.length - 8)}${key.slice(-4)}`;
}

export function loadSavedConfig(): NineRouterConfig | null {
	try {
		const path = configPath();
		if (!existsSync(path)) return null;
		const data = JSON.parse(readFileSync(path, "utf8")) as Partial<NineRouterConfig>;
		if (!data.baseUrl || typeof data.baseUrl !== "string") return null;
		return {
			baseUrl: normalizeBaseUrl(data.baseUrl),
			apiKey: typeof data.apiKey === "string" && data.apiKey.trim() ? data.apiKey.trim() : undefined,
			enableReasoning: data.enableReasoning !== false,
		};
	} catch {
		return null;
	}
}

export function saveConfig(config: NineRouterConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				baseUrl: config.baseUrl,
				apiKey: config.apiKey,
				enableReasoning: config.enableReasoning,
				configVersion: CONFIG_VERSION,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
}

export function loadConfig(): NineRouterConfig {
	const saved = loadSavedConfig();
	return {
		baseUrl: normalizeBaseUrl(
			envFirst("NINE_ROUTER_BASE_URL", "9ROUTER_BASE_URL") || saved?.baseUrl || DEFAULT_BASE_URL,
		),
		apiKey: envFirst("NINE_ROUTER_API_KEY", "9ROUTER_API_KEY") || saved?.apiKey,
		enableReasoning:
			parseBooleanFlag(envFirst("NINE_ROUTER_ENABLE_REASONING", "9ROUTER_ENABLE_REASONING")) ??
			saved?.enableReasoning ??
			true,
	};
}

export function configSummary(config: NineRouterConfig): string {
	return [
		`Endpoint: ${apiEndpoint(config)}`,
		`API key: ${maskApiKey(config.apiKey)}`,
		`Reasoning: ${config.enableReasoning ? "per-model" : "forced off"}`,
	].join("\n");
}
