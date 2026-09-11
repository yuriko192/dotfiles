/**
 * MCP client for pi.
 *
 * Connects pi to external MCP servers (HTTP / SSE URLs, plus optional stdio).
 * One `mcp` proxy tool keeps remote catalogs out of the system prompt until
 * the agent searches or calls them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { McpClient } from "./client.ts";
import { formatConfigHelp, loadMcpConfig } from "./config.ts";
import { formatImportSummary, importHostMcpConfigs } from "./import.ts";
import type { LoadedMcpConfig, McpToolDefinition, ResolvedServer } from "./types.ts";

const QUALIFIER = "/";

interface McpParams {
	search?: string;
	tool?: string;
	args?: string;
	server?: string;
	describe?: boolean;
}

function qualify(serverName: string, toolName: string): string {
	return `${serverName}${QUALIFIER}${toolName}`;
}

function parseQualified(value: string): { server?: string; tool: string } {
	const slash = value.indexOf("/");
	if (slash > 0) return { server: value.slice(0, slash), tool: value.slice(slash + 1) };
	const dunder = value.indexOf("__");
	if (dunder > 0) return { server: value.slice(0, dunder), tool: value.slice(dunder + 2) };
	return { tool: value };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
	if (raw === undefined || raw.trim() === "") return {};
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("mcp args must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function formatSchema(tool: McpToolDefinition): string {
	const hints: string[] = [];
	const annotations = tool.annotations;
	if (annotations?.readOnlyHint) hints.push("read-only");
	if (annotations?.destructiveHint) hints.push("destructive");
	if (annotations?.idempotentHint) hints.push("idempotent");
	if (annotations?.openWorldHint) hints.push("open-world");
	const header = [tool.description?.trim() || "(no description)", hints.length ? `[${hints.join(", ")}]` : ""]
		.filter(Boolean)
		.join(" ");
	const schema = tool.inputSchema
		? JSON.stringify(tool.inputSchema, null, 2)
		: "{ }";
	return `${header}\n\nParameters:\n${schema}`;
}

function formatToolLine(serverName: string, tool: McpToolDefinition): string {
	const description = tool.description?.replace(/\s+/g, " ").trim() ?? "";
	return description
		? `${qualify(serverName, tool.name)}  ${description}`
		: qualify(serverName, tool.name);
}

class McpManager {
	private config: LoadedMcpConfig = { servers: [], requestTimeoutMs: 30_000, sources: [] };
	private readonly clients = new Map<string, McpClient>();
	private cwd = process.cwd();
	private projectTrusted = false;

	reload(cwd: string, projectTrusted: boolean): void {
		this.cwd = cwd;
		this.projectTrusted = projectTrusted;
		this.config = loadMcpConfig({ cwd, projectTrusted });
		for (const [name, client] of this.clients) {
			const server = this.enabledServers().find((entry) => entry.name === name);
			const stale =
				!server ||
				server.url !== client.server.url ||
				server.command !== client.server.command;
			if (stale) {
				void client.close();
				this.clients.delete(name);
			}
		}
	}

	enabledServers(): ResolvedServer[] {
		return this.config.servers.filter((server) => !server.disabled);
	}

	sources(): string[] {
		return this.config.sources;
	}

	statusLines(): string {
		const servers = this.enabledServers();
		if (servers.length === 0) return formatConfigHelp();
		const lines = [`MCP servers (${servers.length})`];
		if (this.config.sources.length > 0) {
			lines.push(`config: ${this.config.sources.join(", ")}`);
		}
		for (const server of servers) {
			const client = this.clients.get(server.name);
			const state = client?.state ?? "idle";
			const tools = client?.tools.length ? `, ${client.tools.length} tools` : "";
			const error = client?.lastError ? `\n    ${client.lastError.split("\n")[0]}` : "";
			const origin = server.importedFrom ? `  ← ${server.importedFrom}` : "";
			lines.push(`  ${server.name}  ${state}  ${server.transport}  ${server.lifecycle}${tools}${origin}${error}`);
		}
		return lines.join("\n");
	}

	async startEager(signal?: AbortSignal): Promise<string[]> {
		const errors: string[] = [];
		for (const server of this.enabledServers()) {
			if (server.lifecycle !== "eager") continue;
			try {
				await this.ensureClient(server.name).connect(signal);
			} catch (error) {
				errors.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return errors;
	}

	async start(name: string, signal?: AbortSignal): Promise<void> {
		await this.ensureClient(name).connect(signal);
	}

	async stop(name: string): Promise<void> {
		const client = this.clients.get(name);
		if (!client) return;
		await client.close();
		this.clients.delete(name);
	}

	async shutdown(): Promise<void> {
		const clients = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(clients.map((client) => client.close()));
	}

	async listTools(serverName?: string, signal?: AbortSignal): Promise<string> {
		const servers = this.serversFor(serverName);
		if (servers.length === 0) return formatConfigHelp();
		const lines: string[] = [];
		const errors: string[] = [];
		for (const server of servers) {
			try {
				const tools = await this.toolsFromServer(server, signal);
				lines.push(`${server.name} (${tools.length})`);
				for (const tool of tools) lines.push(`  ${formatToolLine(server.name, tool)}`);
			} catch (error) {
				errors.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (lines.length === 0 && errors.length > 0) throw new Error(errors.join("\n"));
		if (errors.length > 0) {
			lines.push("", "Unreachable:");
			for (const line of errors) lines.push(`  ${line}`);
		}
		return lines.join("\n");
	}

	async search(query: string, serverName: string | undefined, signal?: AbortSignal): Promise<string> {
		const servers = this.serversFor(serverName);
		if (servers.length === 0) return formatConfigHelp();
		const needle = query.toLowerCase();
		const matches: string[] = [];
		const errors: string[] = [];
		for (const server of servers) {
			try {
				const tools = await this.toolsFromServer(server, signal);
				for (const tool of tools) {
					const qualified = qualify(server.name, tool.name);
					const haystack = `${qualified} ${tool.name} ${tool.description ?? ""}`.toLowerCase();
					if (haystack.includes(needle)) matches.push(formatToolLine(server.name, tool));
				}
			} catch (error) {
				errors.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (matches.length === 0 && errors.length === 0) {
			return `No MCP tools matched ${JSON.stringify(query)}.`;
		}
		const lines = [...matches];
		if (errors.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push("Unreachable:");
			for (const line of errors) lines.push(`  ${line}`);
		}
		if (matches.length === 0) {
			lines.unshift(`No MCP tools matched ${JSON.stringify(query)}.`);
		}
		return lines.join("\n");
	}

	async describe(toolRef: string, serverHint: string | undefined, signal?: AbortSignal): Promise<string> {
		const resolved = await this.resolveTool(toolRef, serverHint, signal);
		return `${qualify(resolved.server.name, resolved.tool.name)}\n${formatSchema(resolved.tool)}`;
	}

	async call(
		toolRef: string,
		rawArgs: string | undefined,
		serverHint: string | undefined,
		signal?: AbortSignal,
	): Promise<{ server: string; tool: string; result: Awaited<ReturnType<McpClient["callTool"]>> }> {
		const resolved = await this.resolveTool(toolRef, serverHint, signal);
		const result = await this.ensureClient(resolved.server.name).callTool(
			resolved.tool.name,
			parseArgs(rawArgs),
			signal,
		);
		return { server: resolved.server.name, tool: resolved.tool.name, result };
	}

	serverNames(): string[] {
		return this.enabledServers().map((server) => server.name);
	}

	private serversFor(serverName?: string): ResolvedServer[] {
		const servers = this.enabledServers();
		if (!serverName) return servers;
		const found = servers.find((server) => server.name === serverName);
		if (!found) {
			throw new Error(`Unknown MCP server "${serverName}". Known: ${servers.map((server) => server.name).join(", ") || "(none)"}`);
		}
		return [found];
	}

	private ensureClient(name: string): McpClient {
		const existing = this.clients.get(name);
		if (existing) return existing;
		const server = this.serversFor(name)[0];
		const client = new McpClient(server, server.cwd || this.cwd);
		this.clients.set(name, client);
		return client;
	}

	private refreshImportedUrls(): boolean {
		const before = new Map(
			this.enabledServers().map((server) => [server.name, `${server.url ?? ""}\0${server.command ?? ""}`]),
		);
		importHostMcpConfigs({ cwd: this.cwd, projectTrusted: this.projectTrusted });
		this.reload(this.cwd, this.projectTrusted);
		return this.enabledServers().some((server) => before.get(server.name) !== `${server.url ?? ""}\0${server.command ?? ""}`);
	}

	private async toolsFromServer(
		server: ResolvedServer,
		signal?: AbortSignal,
	): Promise<McpToolDefinition[]> {
		try {
			return await this.ensureClient(server.name).listTools(signal);
		} catch (error) {
			if (this.refreshImportedUrls()) {
				return await this.ensureClient(server.name).listTools(signal);
			}
			throw error;
		}
	}

	private async resolveTool(
		toolRef: string,
		serverHint: string | undefined,
		signal?: AbortSignal,
	): Promise<{ server: ResolvedServer; tool: McpToolDefinition }> {
		const parsed = parseQualified(toolRef);
		const serverName = serverHint ?? parsed.server;
		const servers = this.serversFor(serverName);
		const hits: Array<{ server: ResolvedServer; tool: McpToolDefinition }> = [];
		const errors: string[] = [];
		for (const server of servers) {
			try {
				const tools = await this.toolsFromServer(server, signal);
				for (const tool of tools) {
					if (tool.name === parsed.tool || qualify(server.name, tool.name) === toolRef) {
						hits.push({ server, tool });
					}
				}
			} catch (error) {
				errors.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (hits.length === 1) return hits[0];
		if (hits.length === 0) {
			const detail = errors.length > 0 ? `\n${errors.join("\n")}` : "";
			throw new Error(`Unknown MCP tool "${toolRef}". Use mcp with search to find names.${detail}`);
		}
		const names = hits.map((hit) => qualify(hit.server.name, hit.tool.name)).join(", ");
		throw new Error(`MCP tool "${parsed.tool}" is ambiguous (${names}). Pass server or a qualified name.`);
	}
}

export default function mcpExtension(pi: ExtensionAPI) {
	const manager = new McpManager();

	const refreshStatus = (ctx: { ui: { setStatus: (id: string, text: string | undefined) => void } }) => {
		const servers = manager.enabledServers();
		if (servers.length === 0) {
			ctx.ui.setStatus("mcp", undefined);
			return;
		}
		ctx.ui.setStatus("mcp", `mcp ${servers.length}`);
	};

	pi.on("session_start", async (_event, ctx) => {
		await manager.shutdown();
		let imported: ReturnType<typeof importHostMcpConfigs> | undefined;
		try {
			imported = importHostMcpConfigs({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
			});
		} catch (error) {
			ctx.ui.notify(
				`MCP import failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
		manager.reload(ctx.cwd, ctx.isProjectTrusted());
		const errors = await manager.startEager();
		refreshStatus(ctx);
		if (
			imported &&
			(imported.added.length > 0 || imported.updated.length > 0 || imported.warnings.length > 0)
		) {
			ctx.ui.notify(formatImportSummary(imported), imported.warnings.length > 0 ? "warning" : "info");
		} else if (errors.length > 0) {
			ctx.ui.notify(`MCP eager start failed:\n${errors.join("\n")}`, "warning");
		} else if (manager.enabledServers().length > 0) {
			ctx.ui.notify(manager.statusLines(), "info");
		}
	});

	pi.on("session_shutdown", async () => {
		await manager.shutdown();
	});

	pi.registerTool({
		name: "mcp",
		label: "MCP",
		description:
			"Discover and call tools on external MCP servers. List with no arguments, search to find a tool, describe to read its schema, then call with tool plus args.",
		promptSnippet: "List, search, describe, or call tools on external MCP servers",
		promptGuidelines: [
			"Use mcp to reach external MCP servers. Call mcp with no arguments to list servers and tools, search to find a tool, describe to read its schema, then call with tool and args.",
			"When the user names DataGrip, GoLand, or another IDE, pass server as that MCP name (datagrip, goland) so mcp does not probe every imported host.",
			"MCP tool names are server/tool. Do not dump every MCP schema into the conversation; describe only the tool you are about to call.",
		],
		parameters: Type.Object({
			search: Type.Optional(
				Type.String({ description: "Find tools by name or description" }),
			),
			tool: Type.Optional(
				Type.String({ description: "Tool to describe or call. Prefer server/tool." }),
			),
			args: Type.Optional(
				Type.String({
					description: "JSON object of arguments for a tool call, as a JSON string",
				}),
			),
			server: Type.Optional(
				Type.String({ description: "Limit list, search, or an unqualified tool to this server" }),
			),
			describe: Type.Optional(
				Type.Boolean({ description: "If true with tool, return the schema instead of calling" }),
			),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			if (input.args !== undefined && typeof input.args !== "string") {
				return { ...input, args: JSON.stringify(input.args) };
			}
			return args;
		},
		async execute(_toolCallId, params: McpParams, signal, onUpdate) {
			if (params.tool && !params.describe && params.search === undefined) {
				onUpdate?.({ content: [{ type: "text", text: `Calling ${params.tool}...` }] });
				const called = await manager.call(params.tool, params.args, params.server, signal);
				if (called.result.isError) {
					const text = called.result.content
						.map((block) => (block.type === "text" || block.type === "other" ? block.text : "[image]"))
						.join("\n");
					throw new Error(text || `MCP tool ${qualify(called.server, called.tool)} failed`);
				}
				return {
					content: called.result.content.map((block) =>
						block.type === "image"
							? { type: "image" as const, data: block.data, mimeType: block.mimeType }
							: { type: "text" as const, text: block.text },
					),
					details: { server: called.server, tool: called.tool },
				};
			}

			if (params.tool && params.describe) {
				const text = await manager.describe(params.tool, params.server, signal);
				return { content: [{ type: "text", text }], details: { describe: params.tool } };
			}

			if (params.search) {
				const text = await manager.search(params.search, params.server, signal);
				return { content: [{ type: "text", text }], details: { search: params.search } };
			}

			const text = await manager.listTools(params.server, signal);
			return { content: [{ type: "text", text }], details: { list: true } };
		},
	});

	const completeServers = (prefix: string): AutocompleteItem[] | null => {
		const items = manager.serverNames().map((name) => ({ value: name, label: name }));
		const filtered = items.filter((item) => item.value.startsWith(prefix));
		return filtered.length > 0 ? filtered : null;
	};

	pi.registerCommand("mcp", {
		description: "MCP status, or: start|stop|tools [server]",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const actions = ["import", "start", "stop", "tools"].map((value) => ({ value, label: value }));
				return actions.filter((item) => item.value.startsWith(prefix));
			}
			return completeServers(parts[parts.length - 1] ?? "");
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const action = tokens[0] ?? "";
			const target = tokens[1];
			try {
				if (!action) {
					ctx.ui.notify(manager.statusLines(), "info");
					return;
				}
				if (action === "import") {
					const imported = importHostMcpConfigs({
						cwd: ctx.cwd,
						projectTrusted: ctx.isProjectTrusted(),
					});
					manager.reload(ctx.cwd, ctx.isProjectTrusted());
					refreshStatus(ctx);
					ctx.ui.notify(formatImportSummary(imported), imported.warnings.length > 0 ? "warning" : "info");
					return;
				}
				if (action === "start") {
					if (!target) {
						ctx.ui.notify("Usage: /mcp start <server>", "warning");
						return;
					}
					await manager.start(target);
					refreshStatus(ctx);
					ctx.ui.notify(manager.statusLines(), "info");
					return;
				}
				if (action === "stop") {
					if (!target) {
						ctx.ui.notify("Usage: /mcp stop <server>", "warning");
						return;
					}
					await manager.stop(target);
					refreshStatus(ctx);
					ctx.ui.notify(`Stopped ${target}`, "info");
					return;
				}
				if (action === "tools") {
					ctx.ui.notify(await manager.listTools(target), "info");
					return;
				}
				ctx.ui.notify("Usage: /mcp [import|start|stop|tools] [server]", "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("mcp:import", {
		description: "Import Cursor, Claude, and other host MCP configs into ~/.pi/agent/mcp.json",
		handler: async (_args, ctx) => {
			try {
				const imported = importHostMcpConfigs({
					cwd: ctx.cwd,
					projectTrusted: ctx.isProjectTrusted(),
				});
				manager.reload(ctx.cwd, ctx.isProjectTrusted());
				refreshStatus(ctx);
				ctx.ui.notify(formatImportSummary(imported), imported.warnings.length > 0 ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("mcp:start", {
		description: "Connect an MCP server: /mcp:start <server>",
		getArgumentCompletions: completeServers,
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /mcp:start <server>", "warning");
				return;
			}
			try {
				await manager.start(name);
				refreshStatus(ctx);
				ctx.ui.notify(manager.statusLines(), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("mcp:stop", {
		description: "Disconnect an MCP server: /mcp:stop <server>",
		getArgumentCompletions: completeServers,
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /mcp:stop <server>", "warning");
				return;
			}
			await manager.stop(name);
			refreshStatus(ctx);
			ctx.ui.notify(`Stopped ${name}`, "info");
		},
	});
}
