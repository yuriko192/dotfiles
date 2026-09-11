export type McpTransport = "stdio" | "streamable-http" | "sse";
export type McpLifecycle = "lazy" | "eager";

export interface McpServerConfig {
	transport?: McpTransport | "http";
	type?: McpTransport | "http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	lifecycle?: McpLifecycle;
	disabled?: boolean;
	requestTimeoutMs?: number;
	importedFrom?: string;
}

export interface McpFileSettings {
	requestTimeoutMs?: number;
}

export interface McpImportedSource {
	host: string;
	path: string;
}

export interface McpConfigFile {
	mcpServers?: Record<string, McpServerConfig>;
	settings?: McpFileSettings;
	imported?: {
		updatedAt: string;
		sources: McpImportedSource[];
	};
}

export interface McpImportResult {
	path: string;
	added: string[];
	updated: string[];
	skipped: string[];
	warnings: string[];
	sources: McpImportedSource[];
}

export interface ResolvedServer {
	name: string;
	transport: McpTransport;
	command?: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	url?: string;
	headers: Record<string, string>;
	lifecycle: McpLifecycle;
	disabled: boolean;
	requestTimeoutMs: number;
	source: string;
	importedFrom?: string;
}

export interface LoadedMcpConfig {
	servers: ResolvedServer[];
	requestTimeoutMs: number;
	sources: string[];
}

export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	annotations?: {
		title?: string;
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
}

export interface McpCallResult {
	content: McpContentBlock[];
	structuredContent?: unknown;
	isError?: boolean;
}

export type McpContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "other"; text: string };

export type ConnectionState = "idle" | "connecting" | "connected" | "error";
