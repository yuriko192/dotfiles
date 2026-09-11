const BRIDGE_CALL_ID = "9router-cursor-chat-bridge";

interface ChatMessage {
	role?: string;
	content?: unknown;
	tool_calls?: unknown;
	tool_call_id?: unknown;
	[key: string]: unknown;
}

interface ChatPayload {
	messages?: ChatMessage[];
	tools?: unknown;
	[key: string]: unknown;
}

export function isCursorRoute(modelId: string | undefined): boolean {
	return typeof modelId === "string" && (modelId === "cu" || modelId.startsWith("cu/"));
}

function hasToolHistory(messages: ChatMessage[]): boolean {
	return messages.some((message) => {
		if (message.role === "tool") return true;
		return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
	});
}

/**
 * 9router's Cursor provider uses AgentService for text-only first turns.
 * That path only accepts Cursor IDE/MCP execs, so Pi tools fail with
 * "Cursor AgentService requested an unsupported IDE tool". A real
 * assistant tool_call + tool result forces the Chat Completions path.
 */
export function forceCursorChatCompletions(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const chat = payload as ChatPayload;
	if (!Array.isArray(chat.tools) || chat.tools.length === 0) return payload;
	const messages = Array.isArray(chat.messages) ? [...chat.messages] : [];
	if (messages.length === 0 || hasToolHistory(messages)) return payload;

	const insertAt = messages.findIndex((message) => message.role !== "system");
	const index = insertAt < 0 ? messages.length : insertAt;
	const bridge: ChatMessage[] = [
		{
			role: "assistant",
			content: "",
			tool_calls: [
				{
					id: BRIDGE_CALL_ID,
					type: "function",
					function: { name: "bash", arguments: '{"command":"true"}' },
				},
			],
		},
		{
			role: "tool",
			tool_call_id: BRIDGE_CALL_ID,
			content: "ok",
		},
	];
	return {
		...chat,
		messages: [...messages.slice(0, index), ...bridge, ...messages.slice(index)],
	};
}

export function cursorRouteWarning(modelId: string): string {
	return (
		`9router/${modelId} is a Cursor IDE route. 9router does not expose Pi tools ` +
		`on cu/* (AgentService rejects them). Use a cc/ or cosmoshub/ model for agent work.`
	);
}

export function rewriteCursorAgentError(errorMessage: string | undefined): string | undefined {
	if (!errorMessage || !errorMessage.includes("unsupported IDE tool")) return errorMessage;
	return (
		"Cursor AgentService rejected a Pi tool. Switch off cu/* " +
		"(use 9router cc/... or cosmoshub/...) so 9router keeps OpenAI tool calls."
	);
}
