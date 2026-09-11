import { spawn, type ChildProcess } from "node:child_process";
import type {
	ConnectionState,
	McpCallResult,
	McpContentBlock,
	McpToolDefinition,
	ResolvedServer,
} from "./types.ts";

const PROTOCOL_VERSION = "2025-03-26";
const FALLBACK_PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "pi-mcp", version: "1.0.0" };
const MAX_TOOL_PAGES = 100;
const STDERR_LIMIT = 8_192;

type JsonRpcId = number | string;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	result: unknown;
}

interface JsonRpcFailure {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	error: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

function isFailure(message: object): message is JsonRpcFailure {
	return "error" in message;
}

function isSuccess(message: object): message is JsonRpcSuccess {
	return "result" in message;
}

function explainFetchError(error: unknown, label: string, url?: string): Error {
	const target = url ? `${label} ${url}` : label;
	if (error instanceof Error && error.name === "AbortError") {
		return new Error(`${target}: aborted`);
	}
	const cause =
		error instanceof Error && "cause" in error && error.cause instanceof Error
			? error.cause
			: undefined;
	const code =
		cause && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
	if (
		code === "ECONNREFUSED" ||
		code === "ENOTFOUND" ||
		(error instanceof TypeError && /fetch failed/i.test(error.message))
	) {
		const reason = code ?? "fetch failed";
		return new Error(
			`${target}: ${reason}. Is the MCP server running? JetBrains ports change on restart — run /mcp import.`,
		);
	}
	if (error instanceof Error) {
		return new Error(`${target}: ${error.message}`);
	}
	return new Error(`${target}: ${String(error)}`);
}

async function fetchMcp(url: string, init: RequestInit, label: string): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		throw explainFetchError(error, label, url);
	}
}

export class McpClient {
	readonly server: ResolvedServer;
	state: ConnectionState = "idle";
	lastError: string | undefined;
	stderrTail = "";
	tools: McpToolDefinition[] = [];
	private sessionCwd: string;
	private child: ChildProcess | undefined;
	private sessionId: string | undefined;
	private nextId = 1;
	private readonly pending = new Map<
		JsonRpcId,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private stdoutParser: ((chunk: string) => void) | undefined;
	private toolsDirty = false;
	private sseAbort: AbortController | undefined;
	private ssePostUrl: string | undefined;
	private sseEndpointReady: Promise<string> | undefined;

	constructor(server: ResolvedServer, sessionCwd: string) {
		this.server = server;
		this.sessionCwd = sessionCwd;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.state === "connected") {
			if (this.toolsDirty) await this.refreshTools(signal);
			return;
		}
		this.state = "connecting";
		this.lastError = undefined;
		try {
			if (this.server.transport === "stdio") {
				this.startStdio();
			} else if (this.server.transport === "sse") {
				await this.startSse(signal);
			}
			await this.initialize(signal);
			await this.refreshTools(signal);
			this.state = "connected";
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			this.state = "error";
			await this.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		const pendingError = new Error(`MCP server "${this.server.name}" disconnected`);
		for (const [id, waiter] of this.pending) {
			this.pending.delete(id);
			waiter.reject(pendingError);
		}

		if (this.sseAbort) {
			this.sseAbort.abort();
			this.sseAbort = undefined;
			this.ssePostUrl = undefined;
			this.sseEndpointReady = undefined;
		}

		if (this.server.transport === "streamable-http" && this.sessionId && this.server.url) {
			try {
				await fetchMcp(
					this.server.url,
					{ method: "DELETE", headers: this.httpHeaders() },
					`MCP ${this.server.name}`,
				);
			} catch {
				// session teardown is best-effort
			}
		}

		if (this.child) {
			const child = this.child;
			this.child = undefined;
			if (!child.killed) {
				child.kill("SIGTERM");
				const killTimer = setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 1500);
				killTimer.unref();
			}
		}

		this.sessionId = undefined;
		this.stdoutParser = undefined;
		if (this.state !== "error") this.state = "idle";
	}

	async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
		await this.connect(signal);
		if (this.toolsDirty) await this.refreshTools(signal);
		return this.tools;
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpCallResult> {
		await this.connect(signal);
		const result = await this.request(
			"tools/call",
			{ name, arguments: args },
			signal,
		);
		return normalizeCallResult(result);
	}

	private async initialize(signal?: AbortSignal): Promise<void> {
		const preferred =
			this.server.transport === "sse" ? FALLBACK_PROTOCOL_VERSION : PROTOCOL_VERSION;
		const fallback =
			preferred === PROTOCOL_VERSION ? FALLBACK_PROTOCOL_VERSION : PROTOCOL_VERSION;
		const params = {
			protocolVersion: preferred,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		};
		try {
			await this.request("initialize", params, signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("protocol")) throw error;
			await this.request("initialize", { ...params, protocolVersion: fallback }, signal);
		}
		await this.notify("notifications/initialized");
	}

	private async refreshTools(signal?: AbortSignal): Promise<void> {
		const collected: McpToolDefinition[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_TOOL_PAGES; page++) {
			const result = (await this.request(
				"tools/list",
				cursor ? { cursor } : {},
				signal,
			)) as { tools?: McpToolDefinition[]; nextCursor?: string };
			collected.push(...(result.tools ?? []));
			cursor = result.nextCursor;
			if (!cursor) break;
		}
		this.tools = collected;
		this.toolsDirty = false;
	}

	private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextId++;
		const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		return await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				this.pending.delete(id);
				reject(new Error(`MCP ${method} timed out after ${this.server.requestTimeoutMs}ms`));
			}, this.server.requestTimeoutMs);

			const onAbort = () => {
				cleanup();
				this.pending.delete(id);
				void this.notify("notifications/cancelled", { requestId: id, reason: "aborted" });
				reject(new Error(`MCP ${method} aborted`));
			};

			const cleanup = () => {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
			};

			this.pending.set(id, {
				resolve: (value) => {
					cleanup();
					resolve(value);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});

			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}

			void this.send(payload).catch((error) => {
				cleanup();
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	private async notify(method: string, params?: unknown): Promise<void> {
		const payload: JsonRpcNotification = { jsonrpc: "2.0", method };
		if (params !== undefined) payload.params = params;
		await this.send(payload);
	}

	private async send(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
		if (this.server.transport === "stdio") {
			this.sendStdio(message);
			return;
		}
		if (this.server.transport === "sse") {
			await this.sendSse(message);
			return;
		}
		await this.sendHttp(message);
	}

	private startStdio(): void {
		if (!this.server.command) {
			throw new Error(`MCP server "${this.server.name}" is missing command`);
		}
		const child = spawn(this.server.command, this.server.args, {
			cwd: this.server.cwd || this.sessionCwd,
			env: { ...process.env, ...this.server.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.stdoutParser = createStdoutParser((message) => this.onMessage(message));

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.stdoutParser?.(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_LIMIT);
		});
		child.on("error", (error) => {
			this.lastError = error.message;
			this.failPending(error);
		});
		child.on("exit", (code, signalName) => {
			const reason = `MCP server "${this.server.name}" exited (code ${code ?? "?"}, signal ${signalName ?? "none"})`;
			if (this.stderrTail) {
				this.lastError = `${reason}\n${this.stderrTail.trim()}`;
			} else {
				this.lastError = reason;
			}
			if (this.state === "connected" || this.state === "connecting") this.state = "error";
			this.failPending(new Error(this.lastError));
			this.child = undefined;
		});
	}

	private sendStdio(message: JsonRpcRequest | JsonRpcNotification): void {
		if (!this.child?.stdin) {
			throw new Error(`MCP server "${this.server.name}" is not running`);
		}
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private originHeader(): Record<string, string> {
		if (!this.server.url) return {};
		try {
			return { Origin: new URL(this.server.url).origin };
		} catch {
			return {};
		}
	}

	private httpHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version":
				this.server.transport === "sse" ? FALLBACK_PROTOCOL_VERSION : PROTOCOL_VERSION,
			...this.originHeader(),
			...this.server.headers,
		};
		if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
		return headers;
	}

	private async startSse(signal?: AbortSignal): Promise<void> {
		if (!this.server.url) {
			throw new Error(`MCP server "${this.server.name}" is missing url`);
		}
		this.sseAbort = new AbortController();
		if (signal) {
			if (signal.aborted) this.sseAbort.abort();
			else signal.addEventListener("abort", () => this.sseAbort?.abort(), { once: true });
		}

		let resolveEndpoint: (url: string) => void;
		let rejectEndpoint: (error: Error) => void;
		this.sseEndpointReady = new Promise<string>((resolve, reject) => {
			resolveEndpoint = resolve;
			rejectEndpoint = reject;
		});

		const response = await fetchMcp(
			this.server.url,
			{
				method: "GET",
				headers: {
					Accept: "text/event-stream",
					...this.originHeader(),
					...this.server.headers,
				},
				signal: this.sseAbort.signal,
			},
			`MCP SSE ${this.server.name}`,
		);
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(
				`MCP SSE ${response.status} from ${this.server.name}: ${body.slice(0, 400) || response.statusText}`,
			);
		}

		void this.consumeSse(response, resolveEndpoint!, rejectEndpoint!);

		const timeout = setTimeout(() => {
			rejectEndpoint!(new Error(`MCP SSE endpoint event timed out for ${this.server.name}`));
		}, this.server.requestTimeoutMs);
		try {
			this.ssePostUrl = await this.sseEndpointReady;
		} finally {
			clearTimeout(timeout);
		}
	}

	private async consumeSse(
		response: Response,
		resolveEndpoint: (url: string) => void,
		rejectEndpoint: (error: Error) => void,
	): Promise<void> {
		try {
			for await (const event of iterateSse(response)) {
				if (event.event === "endpoint") {
					this.ssePostUrl = new URL(event.data.trim(), this.server.url).toString();
					resolveEndpoint(this.ssePostUrl);
					continue;
				}
				if (event.data) parseJsonMessage(event.data, (message) => this.onMessage(message));
			}
		} catch (error) {
			if (this.sseAbort?.signal.aborted) return;
			const failed = error instanceof Error ? error : new Error(String(error));
			this.lastError = failed.message;
			rejectEndpoint(failed);
			this.failPending(failed);
		}
	}

	private async sendSse(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
		if (!this.ssePostUrl) {
			throw new Error(`MCP server "${this.server.name}" has no SSE message endpoint`);
		}
		const response = await fetchMcp(
			this.ssePostUrl,
			{
				method: "POST",
				headers: this.httpHeaders(),
				body: JSON.stringify(message),
			},
			`MCP SSE ${this.server.name}`,
		);
		if (response.status === 202) {
			await response.arrayBuffer().catch(() => undefined);
			return;
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(
				`MCP SSE POST ${response.status} from ${this.server.name}: ${body.slice(0, 400) || response.statusText}`,
			);
		}
		const contentType = response.headers.get("content-type") ?? "";
		if (!("id" in message)) {
			await response.arrayBuffer().catch(() => undefined);
			return;
		}
		if (contentType.includes("application/json")) {
			const parsed = (await response.json()) as JsonRpcMessage;
			this.onMessage(parsed);
			return;
		}
		await response.arrayBuffer().catch(() => undefined);
	}

	private async sendHttp(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
		if (!this.server.url) {
			throw new Error(`MCP server "${this.server.name}" is missing url`);
		}
		const response = await fetchMcp(
			this.server.url,
			{
				method: "POST",
				headers: this.httpHeaders(),
				body: JSON.stringify(message),
			},
			`MCP HTTP ${this.server.name}`,
		);
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.sessionId = sessionId;
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(
				`MCP HTTP ${response.status} from ${this.server.name}: ${body.slice(0, 400) || response.statusText}`,
			);
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (!("id" in message)) {
			if (contentType.includes("text/event-stream")) await response.body?.cancel();
			else await response.arrayBuffer().catch(() => undefined);
			return;
		}

		if (contentType.includes("text/event-stream")) {
			const parsed = await readSseResult(response, message.id);
			this.onMessage(parsed);
			return;
		}

		const parsed = (await response.json()) as JsonRpcMessage;
		this.onMessage(parsed);
	}

	private onMessage(message: JsonRpcMessage): void {
		if ("method" in message && message.method === "notifications/tools/list_changed") {
			this.toolsDirty = true;
			return;
		}
		if (!("id" in message) || message.id === null || message.id === undefined) return;
		const waiter = this.pending.get(message.id);
		if (!waiter) return;
		this.pending.delete(message.id);
		if (isFailure(message)) {
			const detail = message.error.data !== undefined ? ` ${JSON.stringify(message.error.data)}` : "";
			waiter.reject(new Error(`${message.error.message}${detail}`));
			return;
		}
		if (isSuccess(message)) {
			waiter.resolve(message.result);
		}
	}

	private failPending(error: Error): void {
		for (const [id, waiter] of this.pending) {
			this.pending.delete(id);
			waiter.reject(error);
		}
	}
}

function createStdoutParser(onMessage: (message: JsonRpcMessage) => void): (chunk: string) => void {
	let buffer = "";
	return (chunk: string) => {
		buffer += chunk;
		while (buffer.length > 0) {
			const headerMatch = /^(?:Content-Length|content-length):\s*(\d+)/i.exec(buffer);
			if (headerMatch) {
				const headerEnd = buffer.includes("\r\n\r\n")
					? buffer.indexOf("\r\n\r\n") + 4
					: buffer.includes("\n\n")
						? buffer.indexOf("\n\n") + 2
						: -1;
				if (headerEnd === -1) return;
				const length = Number(headerMatch[1]);
				if (buffer.length < headerEnd + length) return;
				const raw = buffer.slice(headerEnd, headerEnd + length);
				buffer = buffer.slice(headerEnd + length);
				parseJsonMessage(raw, onMessage);
				continue;
			}

			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) parseJsonMessage(line, onMessage);
		}
	};
}

function parseJsonMessage(raw: string, onMessage: (message: JsonRpcMessage) => void): void {
	try {
		const parsed = JSON.parse(raw) as JsonRpcMessage;
		onMessage(parsed);
	} catch {
		// ignore non-JSON stdout noise from some servers
	}
}

async function* iterateSse(response: Response): AsyncGenerator<{ event: string; data: string }> {
	if (!response.body) throw new Error("MCP SSE response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName = "message";
	let dataLines: string[] = [];

	const flush = (): { event: string; data: string } | undefined => {
		const data = dataLines.join("\n");
		const event = eventName || "message";
		eventName = "message";
		dataLines = [];
		if (data === "") return undefined;
		return { event, data };
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				const trailing = flush();
				if (trailing) yield trailing;
				return;
			}
			buffer += decoder.decode(value, { stream: true });
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line === "") {
					const event = flush();
					if (event) yield event;
					continue;
				}
				if (line.startsWith(":")) continue;
				if (line.startsWith("event:")) {
					eventName = line.slice(6).trim();
					continue;
				}
				if (line.startsWith("data:")) {
					dataLines.push(line.slice(5).replace(/^ /, ""));
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

async function readSseResult(response: Response, requestId: JsonRpcId): Promise<JsonRpcMessage> {
	for await (const event of iterateSse(response)) {
		if (!event.data) continue;
		try {
			const parsed = JSON.parse(event.data) as JsonRpcMessage;
			if ("id" in parsed && parsed.id === requestId) return parsed;
		} catch {
			// ignore keep-alives and non-JSON SSE frames
		}
	}
	throw new Error("MCP SSE stream ended without a matching response");
}

function normalizeCallResult(result: unknown): McpCallResult {
	if (!result || typeof result !== "object") {
		return { content: [{ type: "text", text: String(result) }] };
	}
	const payload = result as {
		content?: unknown[];
		structuredContent?: unknown;
		isError?: boolean;
	};
	const content = (payload.content ?? []).map(normalizeContentBlock);
	if (payload.structuredContent !== undefined) {
		content.push({
			type: "text",
			text: JSON.stringify(payload.structuredContent, null, 2),
		});
	}
	if (content.length === 0) content.push({ type: "text", text: "(empty MCP result)" });
	return { content, structuredContent: payload.structuredContent, isError: payload.isError };
}

function normalizeContentBlock(block: unknown): McpContentBlock {
	if (!block || typeof block !== "object") {
		return { type: "text", text: String(block) };
	}
	const item = block as Record<string, unknown>;
	if (item.type === "text" && typeof item.text === "string") {
		return { type: "text", text: item.text };
	}
	if (item.type === "image" && typeof item.data === "string") {
		const mimeType =
			(typeof item.mimeType === "string" && item.mimeType) ||
			(typeof item.mediaType === "string" && item.mediaType) ||
			"image/png";
		return { type: "image", data: item.data, mimeType };
	}
	if (item.type === "resource" && item.resource && typeof item.resource === "object") {
		const resource = item.resource as Record<string, unknown>;
		if (typeof resource.text === "string") {
			return { type: "text", text: resource.text };
		}
	}
	return { type: "other", text: JSON.stringify(item) };
}
