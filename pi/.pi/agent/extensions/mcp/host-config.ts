import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpConfigFile, McpImportResult, McpImportedSource, McpServerConfig } from "./types.ts";

export interface HostSource {
	host: string;
	path: string;
}

export function listHostSources(options: { cwd: string; projectTrusted: boolean }): HostSource[] {
	const home = homedir();
	const sources: HostSource[] = [
		{ host: "cursor", path: join(home, ".cursor", "mcp.json") },
		{ host: "claude", path: join(home, ".claude.json") },
		{ host: "claude", path: join(home, ".claude", "settings.json") },
		{ host: "claude", path: join(home, ".claude", "settings.local.json") },
		{
			host: "claude-desktop",
			path: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
		},
		{ host: "shared", path: join(home, ".config", "mcp", "mcp.json") },
		{ host: "shared", path: join(home, ".agents", "mcp.json") },
		{ host: "shared", path: join(home, ".agents", "mcp", "mcp.json") },
		{ host: "copilot", path: join(home, ".config", "github-copilot", "intellij", "mcp.json") },
	];

	if (options.projectTrusted) {
		sources.push(
			{ host: "cursor", path: join(options.cwd, ".cursor", "mcp.json") },
			{ host: "shared", path: join(options.cwd, ".mcp.json") },
			{ host: "claude", path: join(options.cwd, ".claude", "settings.json") },
			{ host: "claude", path: join(options.cwd, ".claude", "settings.local.json") },
			{ host: "vscode", path: join(options.cwd, ".vscode", "mcp.json") },
		);
	}

	return sources;
}

export function stripJsonc(raw: string): string {
	let output = "";
	let index = 0;
	let inString = false;
	let quote = "";
	let escaped = false;
	while (index < raw.length) {
		const char = raw[index];
		const next = raw[index + 1];
		if (inString) {
			output += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) inString = false;
			index += 1;
			continue;
		}
		if (char === "\"" || char === "'") {
			inString = true;
			quote = char;
			output += char;
			index += 1;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < raw.length && raw[index] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index + 1 < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) index += 1;
			index += 2;
			continue;
		}
		output += char;
		index += 1;
	}
	return output;
}

function parseConfigText(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return JSON.parse(stripJsonc(raw));
	}
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") record[key] = entry;
	}
	return Object.keys(record).length > 0 ? record : undefined;
}

function normalizeHostEntry(entry: unknown): McpServerConfig | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const raw = entry as Record<string, unknown>;
	const url =
		(typeof raw.url === "string" && raw.url) ||
		(typeof raw.httpUrl === "string" && raw.httpUrl) ||
		undefined;
	const command = typeof raw.command === "string" ? raw.command : undefined;
	if (!url && !command) return undefined;

	let headers = stringRecord(raw.headers);
	if (!headers && raw.requestInit && typeof raw.requestInit === "object") {
		headers = stringRecord((raw.requestInit as Record<string, unknown>).headers);
	}

	const type = raw.transport ?? raw.type;
	const normalized: McpServerConfig = {};
	if (url) normalized.url = url;
	if (command) normalized.command = command;
	if (Array.isArray(raw.args)) normalized.args = raw.args.map((arg) => String(arg));
	const env = stringRecord(raw.env);
	if (env) normalized.env = env;
	if (typeof raw.cwd === "string") normalized.cwd = raw.cwd;
	if (headers) normalized.headers = headers;
	if (type === "stdio" || type === "sse" || type === "http" || type === "streamable-http") {
		normalized.type = type;
	}
	if (raw.disabled === true) normalized.disabled = true;
	return normalized;
}

function asServerMap(value: unknown): Record<string, McpServerConfig> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const servers: Record<string, McpServerConfig> = {};
	for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
		const normalized = normalizeHostEntry(entry);
		if (normalized) servers[name] = normalized;
	}
	return servers;
}

export function extractMcpServers(parsed: unknown, cwd?: string): Record<string, McpServerConfig> {
	if (!parsed || typeof parsed !== "object") return {};
	const root = parsed as Record<string, unknown>;
	const servers = {
		...asServerMap(root.servers),
		...asServerMap(root.mcpServers),
	};

	if (cwd && root.projects && typeof root.projects === "object") {
		const project = (root.projects as Record<string, unknown>)[cwd];
		if (project && typeof project === "object") {
			Object.assign(servers, asServerMap((project as Record<string, unknown>).mcpServers));
		}
	}

	return servers;
}

function fingerprint(entry: McpServerConfig): string {
	return JSON.stringify({
		url: entry.url ?? "",
		command: entry.command ?? "",
		args: entry.args ?? [],
	});
}

function readExistingPiFile(path: string): McpConfigFile {
	if (!existsSync(path)) return { mcpServers: {} };
	const parsed = parseConfigText(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object") return { mcpServers: {} };
	return parsed as McpConfigFile;
}

export function writeImportedMcpFile(
	destPath: string,
	options: { cwd: string; projectTrusted: boolean },
): McpImportResult {
	const existing = readExistingPiFile(destPath);
	const servers = { ...(existing.mcpServers ?? {}) };
	const added: string[] = [];
	const updated: string[] = [];
	const skipped: string[] = [];
	const warnings: string[] = [];
	const sources: McpImportedSource[] = [];

	const skip = new Set([destPath, join(options.cwd, ".pi", "mcp.json")]);
	for (const source of listHostSources(options)) {
		if (skip.has(source.path) || !existsSync(source.path)) continue;
		let parsed: unknown;
		try {
			parsed = parseConfigText(readFileSync(source.path, "utf8"));
		} catch (error) {
			warnings.push(`${source.path}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}

		const discovered = extractMcpServers(parsed, options.cwd);
		if (Object.keys(discovered).length === 0) continue;
		sources.push({ host: source.host, path: source.path });

		for (const [name, entry] of Object.entries(discovered)) {
			const incoming = { ...entry, importedFrom: source.host };
			const current = servers[name];
			if (!current) {
				servers[name] = incoming;
				added.push(name);
				continue;
			}

			const sameEndpoint = fingerprint(current) === fingerprint(incoming);
			if (current.importedFrom === source.host) {
				if (!sameEndpoint) updated.push(name);
				servers[name] = { ...incoming, disabled: current.disabled };
				continue;
			}
			if (!current.importedFrom) {
				if (sameEndpoint) {
					skipped.push(name);
					continue;
				}
				const prefixed = `${source.host}_${name}`;
				if (!servers[prefixed]) {
					servers[prefixed] = incoming;
					added.push(prefixed);
				} else {
					skipped.push(prefixed);
				}
				continue;
			}
			if (sameEndpoint) {
				skipped.push(name);
				continue;
			}
			const prefixed = `${source.host}_${name}`;
			if (!servers[prefixed]) {
				servers[prefixed] = incoming;
				added.push(prefixed);
			} else if (servers[prefixed].importedFrom === source.host) {
				if (fingerprint(servers[prefixed]) !== fingerprint(incoming)) updated.push(prefixed);
				servers[prefixed] = { ...incoming, disabled: servers[prefixed].disabled };
			} else {
				skipped.push(prefixed);
			}
		}
	}

	const file: McpConfigFile = {
		...existing,
		imported: {
			updatedAt: new Date().toISOString(),
			sources,
		},
		mcpServers: servers,
	};

	mkdirSync(dirname(destPath), { recursive: true });
	writeFileSync(destPath, `${JSON.stringify(file, null, 2)}\n`);

	return { path: destPath, added, updated, skipped, warnings, sources };
}

export function formatImportSummary(result: McpImportResult): string {
	const lines = [`Imported MCP config → ${result.path}`];
	if (result.sources.length === 0) {
		lines.push("No host MCP files with servers were found.");
		return lines.join("\n");
	}
	lines.push(`sources: ${result.sources.map((source) => `${source.host} (${source.path})`).join(", ")}`);
	if (result.added.length) lines.push(`added: ${result.added.join(", ")}`);
	if (result.updated.length) lines.push(`updated: ${result.updated.join(", ")}`);
	if (result.skipped.length) lines.push(`kept local: ${result.skipped.join(", ")}`);
	if (result.warnings.length) lines.push(`warnings:\n  ${result.warnings.join("\n  ")}`);
	return lines.join("\n");
}
