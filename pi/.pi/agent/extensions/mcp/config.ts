import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	LoadedMcpConfig,
	McpConfigFile,
	McpLifecycle,
	McpServerConfig,
	McpTransport,
	ResolvedServer,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export function expandEnv(value: string): string {
	return value.replace(
		/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(matched, braced: string | undefined, bare: string | undefined) => {
			const key = braced ?? bare;
			if (!key) return matched;
			const found = process.env[key];
			return found !== undefined ? found : matched;
		},
	);
}

function expandRecord(record: Record<string, string> | undefined): Record<string, string> {
	if (!record) return {};
	const expanded: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		if (typeof value === "string") expanded[key] = expandEnv(value);
	}
	return expanded;
}

function readJsonFile(path: string): McpConfigFile | undefined {
	if (!existsSync(path)) return undefined;
	const raw = readFileSync(path, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`MCP config is not an object: ${path}`);
	}
	return parsed as McpConfigFile;
}

function urlLooksLikeSse(url: string): boolean {
	try {
		const path = new URL(url).pathname.toLowerCase();
		return path === "/sse" || path.endsWith("/sse");
	} catch {
		return /\/sse\/?$/i.test(url);
	}
}

function inferTransport(entry: McpServerConfig): McpTransport {
	const declared = entry.transport ?? entry.type;
	if (declared === "http" || declared === "streamable-http") return "streamable-http";
	if (declared === "sse" || declared === "stdio") return declared;
	if (entry.url && urlLooksLikeSse(entry.url)) return "sse";
	if (entry.url) return "streamable-http";
	return "stdio";
}

function sanitizeServerName(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
	return cleaned || "server";
}

function resolveServer(
	name: string,
	entry: McpServerConfig,
	source: string,
	defaultTimeoutMs: number,
): ResolvedServer {
	const transport = inferTransport(entry);
	if (transport === "stdio" && !entry.command) {
		throw new Error(`MCP server "${name}" is stdio but has no command (${source})`);
	}
	if (transport !== "stdio" && !entry.url) {
		throw new Error(`MCP server "${name}" is ${transport} but has no url (${source})`);
	}

	const lifecycle: McpLifecycle = entry.lifecycle === "eager" ? "eager" : "lazy";
	const timeout =
		typeof entry.requestTimeoutMs === "number" && entry.requestTimeoutMs > 0
			? entry.requestTimeoutMs
			: defaultTimeoutMs;

	return {
		name: sanitizeServerName(name),
		transport,
		command: entry.command ? expandEnv(entry.command) : undefined,
		args: (entry.args ?? []).map((arg) => expandEnv(String(arg))),
		env: expandRecord(entry.env),
		cwd: entry.cwd ? expandEnv(entry.cwd) : undefined,
		url: entry.url ? expandEnv(entry.url) : undefined,
		headers: expandRecord(entry.headers),
		lifecycle,
		disabled: entry.disabled === true,
		requestTimeoutMs: timeout,
		source,
		importedFrom: typeof entry.importedFrom === "string" ? entry.importedFrom : undefined,
	};
}

function mergeConfigFiles(files: Array<{ path: string; file: McpConfigFile }>): LoadedMcpConfig {
	const servers = new Map<string, ResolvedServer>();
	let requestTimeoutMs = DEFAULT_TIMEOUT_MS;
	const sources: string[] = [];

	for (const { path, file } of files) {
		sources.push(path);
		if (typeof file.settings?.requestTimeoutMs === "number" && file.settings.requestTimeoutMs > 0) {
			requestTimeoutMs = file.settings.requestTimeoutMs;
		}
		for (const [name, entry] of Object.entries(file.mcpServers ?? {})) {
			servers.set(name, resolveServer(name, entry, path, requestTimeoutMs));
		}
	}

	return {
		servers: [...servers.values()],
		requestTimeoutMs,
		sources,
	};
}

export function loadMcpConfig(options: { cwd: string; projectTrusted: boolean }): LoadedMcpConfig {
	const candidates: string[] = [join(getAgentDir(), "mcp.json")];
	if (options.projectTrusted) {
		candidates.push(join(options.cwd, CONFIG_DIR_NAME, "mcp.json"));
	}

	const files: Array<{ path: string; file: McpConfigFile }> = [];
	for (const path of candidates) {
		const file = readJsonFile(path);
		if (file) files.push({ path, file });
	}

	return mergeConfigFiles(files);
}

export function formatConfigHelp(): string {
	return [
		"No MCP servers in Pi's config. Run /mcp import to copy Cursor, Claude, and other host MCP files into:",
		`  ${join(getAgentDir(), "mcp.json")}`,
		`Project override: ${CONFIG_DIR_NAME}/mcp.json`,
	].join("\n");
}
