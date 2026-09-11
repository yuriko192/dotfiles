/**
 * 9router provider for pi.
 *
 * Discovers models from a local 9router OpenAI-compatible endpoint and
 * registers them as provider `9router`. Capabilities (vision, reasoning,
 * context) come from GET /v1/models.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	fetchModels,
	fetchModelsAtStartup,
	mapModels,
	readModelCache,
	writeModelCache,
	type MappedNineRouterModel,
	type NineRouterModelRaw,
} from "./client.ts";
import {
	apiEndpoint,
	configSummary,
	loadConfig,
	normalizeBaseUrl,
	saveConfig,
	type NineRouterConfig,
} from "./config.ts";
import {
	cursorRouteWarning,
	forceCursorChatCompletions,
	isCursorRoute,
	rewriteCursorAgentError,
} from "./cursor-compat.ts";

const PROVIDER = "9router";
const PLACEHOLDER_API_KEY = "9router-no-api-key";

export default async function nineRouterExtension(pi: ExtensionAPI) {
	let config = loadConfig();
	let discovered: NineRouterModelRaw[] = readModelCache() ?? [];

	function mapped(): MappedNineRouterModel[] {
		return mapModels(discovered, config.enableReasoning);
	}

	function register(models: MappedNineRouterModel[]): void {
		pi.registerProvider(PROVIDER, {
			name: "9router",
			baseUrl: apiEndpoint(config),
			apiKey: config.apiKey || PLACEHOLDER_API_KEY,
			api: "openai-completions",
			models,
			async refreshModels({ signal }) {
				const raw = await fetchModels(config, signal);
				discovered = raw;
				writeModelCache(raw);
				return mapModels(raw, config.enableReasoning);
			},
		});
	}

	async function apply(next: NineRouterConfig, requireFetch = false): Promise<MappedNineRouterModel[]> {
		config = next;
		try {
			discovered = await fetchModels(next);
			writeModelCache(discovered);
		} catch (error) {
			if (requireFetch) throw error;
			discovered = readModelCache() ?? [];
		}
		const models = mapped();
		pi.unregisterProvider(PROVIDER);
		register(models);
		return models;
	}

	async function refreshActiveModel(ctx: ExtensionContext): Promise<void> {
		const active = ctx.model;
		if (active?.provider !== PROVIDER || !active.id) return;
		const refreshed = ctx.modelRegistry.find(PROVIDER, active.id);
		if (refreshed) {
			try {
				await pi.setModel(refreshed);
			} catch {
				// missing auth — ignore
			}
		}
	}

	if (config.baseUrl) {
		try {
			discovered = await fetchModelsAtStartup(config);
			writeModelCache(discovered);
		} catch {
			discovered = readModelCache() ?? discovered;
		}
		register(mapped());
	}

	pi.on("session_start", async (_event, ctx) => {
		await refreshActiveModel(ctx);
		if (ctx.model?.provider === PROVIDER && isCursorRoute(ctx.model.id)) {
			ctx.ui.notify(cursorRouteWarning(ctx.model.id), "warning");
		}
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.model.provider === PROVIDER && isCursorRoute(event.model.id)) {
			ctx.ui.notify(cursorRouteWarning(event.model.id), "warning");
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER || !isCursorRoute(ctx.model.id)) return;
		return forceCursorChatCompletions(event.payload);
	});

	pi.on("message_end", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER || !isCursorRoute(ctx.model.id)) return;
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		const rewritten = rewriteCursorAgentError(message.errorMessage);
		if (!rewritten || rewritten === message.errorMessage) return;
		return { message: { ...message, errorMessage: rewritten } };
	});

	pi.registerTool({
		name: "ask_question",
		label: "ask question",
		description: "Ask the user a multiple-choice question. Used by Cursor routes through 9router.",
		parameters: Type.Object({
			title: Type.Optional(Type.String()),
			question: Type.Optional(Type.String()),
			questions: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.Optional(Type.String()),
						prompt: Type.Optional(Type.String()),
						options: Type.Optional(
							Type.Array(
								Type.Object({
									id: Type.Optional(Type.String()),
									label: Type.Optional(Type.String()),
								}),
							),
						),
					}),
				),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const first = Array.isArray(params.questions) ? params.questions[0] : undefined;
			const question =
				(typeof first?.prompt === "string" && first.prompt.trim()) ||
				(typeof params.question === "string" && params.question.trim()) ||
				(typeof params.title === "string" && params.title.trim()) ||
				"Choose an option";
			const options = (first?.options ?? [])
				.map((option) => option.label || option.id)
				.filter((label): label is string => typeof label === "string" && label.trim().length > 0);

			if (!ctx.hasUI || options.length === 0) {
				return {
					content: [{ type: "text", text: `${question}\nA: no interactive choice available. State an assumption and continue.` }],
					details: { question, skipped: true },
				};
			}
			const choice = await ctx.ui.select(question, options, { signal });
			return {
				content: [{ type: "text", text: `${question}\nA: ${choice ?? "skipped"}` }],
				details: { question, answer: choice ?? null },
			};
		},
	});

	const completeActions = (prefix: string) => {
		const actions = ["setup", "refresh", "models", "reasoning"].map((value) => ({ value, label: value }));
		return actions.filter((item) => item.value.startsWith(prefix));
	};

	async function showStatus(ctx: ExtensionContext): Promise<void> {
		const models = mapped();
		const owners = new Map<string, number>();
		for (const raw of discovered) {
			const owner = raw.owned_by || "other";
			owners.set(owner, (owners.get(owner) ?? 0) + 1);
		}
		const ownerLine = [...owners.entries()]
			.sort((left, right) => left[0].localeCompare(right[0]))
			.map(([owner, count]) => `${owner} ${count}`)
			.join(" · ");
		const cursorNote =
			ctx.model?.provider === PROVIDER && isCursorRoute(ctx.model.id)
				? `\nActive ${ctx.model.id} cannot run Pi tools. Switch to cc/ or cosmoshub/.`
				: "";
		ctx.ui.notify(
			[
				configSummary(config),
				`Models: ${models.length}${ownerLine ? ` (${ownerLine})` : ""}`,
				cursorNote,
				"",
				"/9router setup    configure URL and API key",
				"/9router refresh  re-fetch the catalog",
				"/9router models   list ids (optional filter)",
				"/9router reasoning on|off",
			].join("\n"),
			"info",
		);
	}

	async function runSetup(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("9router setup needs an interactive session.", "warning");
			return;
		}
		const baseUrl = await ctx.ui.input("9router endpoint", config.baseUrl || "http://localhost:20128");
		if (baseUrl === undefined) {
			ctx.ui.notify("Cancelled.", "info");
			return;
		}
		const apiKey = await ctx.ui.input(
			config.apiKey ? "API key (empty keeps current)" : "API key (optional)",
			"",
		);
		if (apiKey === undefined) {
			ctx.ui.notify("Cancelled.", "info");
			return;
		}
		const next: NineRouterConfig = {
			baseUrl: normalizeBaseUrl(baseUrl || config.baseUrl),
			apiKey: apiKey.trim() || config.apiKey,
			enableReasoning: config.enableReasoning,
		};
		saveConfig(next);
		try {
			const models = await apply(next, true);
			await refreshActiveModel(ctx);
			ctx.ui.notify(`9router connected — ${models.length} models.\n${configSummary(next)}`, "info");
		} catch (error) {
			await apply(next);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	async function runRefresh(ctx: ExtensionContext): Promise<void> {
		try {
			const models = await apply(config, true);
			await refreshActiveModel(ctx);
			ctx.ui.notify(`9router refreshed — ${models.length} models.`, models.length > 0 ? "info" : "warning");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	function runModels(args: string, ctx: ExtensionContext): void {
		const filter = args.trim().toLowerCase();
		const ids = mapped()
			.map((model) => model.id)
			.filter((id) => !filter || id.toLowerCase().includes(filter));
		if (ids.length === 0) {
			ctx.ui.notify(filter ? `No 9router models matching "${args.trim()}".` : "No 9router models discovered.", "warning");
			return;
		}
		const preview = ids.slice(0, 80);
		const extra = ids.length > preview.length ? `\n… ${ids.length - preview.length} more` : "";
		ctx.ui.notify(`${ids.length} model${ids.length === 1 ? "" : "s"}\n${preview.join("\n")}${extra}`, "info");
	}

	async function runReasoning(args: string, ctx: ExtensionContext): Promise<void> {
		const token = args.trim().toLowerCase();
		let nextValue = config.enableReasoning;
		if (token === "on" || token === "true" || token === "1") nextValue = true;
		else if (token === "off" || token === "false" || token === "0") nextValue = false;
		else if (!token && ctx.hasUI) {
			const choice = await ctx.ui.select("9router reasoning", ["per-model (on)", "forced off"]);
			if (!choice) return;
			nextValue = choice.startsWith("per-model");
		} else if (!token) {
			ctx.ui.notify(`Reasoning is ${config.enableReasoning ? "per-model" : "forced off"}.`, "info");
			return;
		}
		const next = { ...config, enableReasoning: nextValue };
		saveConfig(next);
		await apply(next);
		await refreshActiveModel(ctx);
		ctx.ui.notify(`9router reasoning ${nextValue ? "per-model" : "forced off"}.`, "info");
	}

	pi.registerCommand("9router", {
		description: "9router status, or: setup|refresh|models|reasoning",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) return completeActions(prefix);
			if (parts[0] === "reasoning" && parts.length === 2) {
				return ["on", "off"]
					.filter((value) => value.startsWith(parts[1] ?? ""))
					.map((value) => ({ value, label: value }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const action = tokens[0] ?? "";
			const rest = tokens.slice(1).join(" ");
			if (!action) {
				await showStatus(ctx);
				return;
			}
			if (action === "setup") {
				await runSetup(ctx);
				return;
			}
			if (action === "refresh") {
				await runRefresh(ctx);
				return;
			}
			if (action === "models") {
				runModels(rest, ctx);
				return;
			}
			if (action === "reasoning") {
				await runReasoning(rest, ctx);
				return;
			}
			ctx.ui.notify("Usage: /9router [setup|refresh|models|reasoning]", "warning");
		},
	});

	pi.registerCommand("9router:setup", {
		description: "Configure the 9router endpoint and API key",
		handler: async (_args, ctx) => {
			await runSetup(ctx);
		},
	});

	pi.registerCommand("9router:refresh", {
		description: "Re-fetch the 9router model catalog",
		handler: async (_args, ctx) => {
			await runRefresh(ctx);
		},
	});
}
