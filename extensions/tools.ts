import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { userConclusionObserver, userConclusionView, type HonchoHandles } from "./client.js";
import {
	resolveConfig,
	saveConfig,
	saveRootField,
	readHonchoConfig,
	type HonchoExtensionConfig,
	type HonchoSessionStrategy,
	type HonchoObservationMode,
	type HonchoReasoningLevel,
	type HonchoEnvironment,
} from "./config.js";
import { searchWorkspaceMessages } from "./raw-search.js";

export interface ToolRegistryDependencies {
	getHandles: (ctx: ExtensionContext) => Promise<HonchoHandles | null>;
}

export function registerTools(pi: ExtensionAPI, deps: ToolRegistryDependencies): void {
	const z = pi.zod;

	pi.registerTool({
		name: "honcho_search",
		label: "Honcho Search",
		description:
			"Search the current Honcho workspace for raw stored messages authored across the developer peer. " +
			"Bounded semantic evidence retrieval over original messages only (never conclusions); " +
			"target=user filters locally to the developer's own messages, target=all keeps every author.",
		parameters: z.object({
			query: z.string().describe("The search query."),
			target: z.enum(["user", "all"]).default("all"),
		}),
		async execute(_id, rawParams, signal, _onUpdate, ctx) {
			const params = rawParams as { query: string; target: "user" | "all" };
			// Resolve credentials/config through the existing read-only API. We do
			// NOT call deps.getHandles here: initialising handles triggers an
			// implicit get-or-create workspace + addPeers write, which this
			// read-only raw retrieval must never perform.
			const config = resolveConfig(ctx.cwd);
			const result = await searchWorkspaceMessages(
				{ apiKey: config.apiKey, baseUrl: config.url, workspaceId: config.workspace },
				params.query,
				{ target: params.target, userPeerId: config.peerName, signal },
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				...(result.isError ? { isError: true } : {}),
			};
		},
	});

	pi.registerTool({
		name: "honcho_get_context",
		label: "Honcho Get Context",
		description:
			"Retrieve Honcho memory context for the developer or AI peer. Use this to recall stable facts and preferences without doing a semantic search.",
		parameters: z.object({
			target: z.enum(["user", "ai"]).default("user"),
			maxConclusions: z.number().int().min(1).max(100).default(15),
		}),
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as { target: "user" | "ai"; maxConclusions: number };
			const handles = await deps.getHandles(ctx);
			if (!handles) {
				return { content: [{ type: "text", text: "Honcho is not initialized for this session." }] };
			}
			try {
				const peer = params.target === "ai" ? handles.aiPeer : userConclusionObserver(handles);
				const target = params.target === "user" && peer === handles.aiPeer ? handles.userPeer : undefined;
				const result = await peer.context({
					...(target ? { target } : {}),
					maxConclusions: params.maxConclusions,
					includeMostFrequent: true,
				});
				const parts: string[] = [];
				if (result.representation) parts.push(result.representation);
				if (result.peerCard?.length) parts.push(...result.peerCard.map((f: string) => `- ${f}`));
				return {
					content: [{ type: "text", text: parts.length ? parts.join("\n\n") : "No context available." }],
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Honcho get_context failed: ${detail}` }],
					isError: true,
				};
			}
		},
	});
	pi.registerTool({
		name: "honcho_get_representation",
		label: "Honcho Get Representation",
		description:
			"Retrieve the developer or AI peer's representation string from Honcho. Lighter-weight than honcho_get_context.",
		parameters: z.object({
			target: z.enum(["user", "ai"]).default("user"),
		}),
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as { target: "user" | "ai" };
			const handles = await deps.getHandles(ctx);
			if (!handles) {
				return { content: [{ type: "text", text: "Honcho is not initialized for this session." }] };
			}
			try {
				const peer = params.target === "ai" ? handles.aiPeer : userConclusionObserver(handles);
				const target = params.target === "user" && peer === handles.aiPeer ? handles.userPeer : undefined;
				const result = await peer.context(target ? { target } : undefined);
				return {
					content: [{ type: "text", text: result.representation || "No representation available." }],
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Honcho get_representation failed: ${detail}` }],
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "honcho_chat",
		label: "Honcho Chat",
		description:
			"Ask Honcho to reason over the developer memory. Useful for summarizing what is known about a topic.",
		parameters: z.object({
			query: z.string().describe("The question to reason about."),
			target: z.enum(["user"]).default("user"),
		}),
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as { query: string; target: "user" };
			const handles = await deps.getHandles(ctx);
			if (!handles) {
				return { content: [{ type: "text", text: "Honcho is not initialized for this session." }] };
			}
			try {
				const answer = await handles.aiPeer.chat(params.query, {
					target: handles.userPeer,
					session: handles.session,
				});
				return {
					content: [{ type: "text", text: answer ?? "No answer returned." }],
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Honcho chat failed: ${detail}` }],
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "honcho_list_conclusions",
		label: "Honcho List Conclusions",
		description:
			"List durable conclusions stored for the developer peer. Useful for inspecting what Honcho currently remembers.",
		parameters: z.object({
			target: z.enum(["user"]).default("user"),
			limit: z.number().int().min(1).max(100).default(20),
		}),
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as { target: "user"; limit: number };
			const handles = await deps.getHandles(ctx);
			if (!handles) {
				return { content: [{ type: "text", text: "Honcho is not initialized for this session." }] };
			}
			try {
				const page = await userConclusionView(handles).list({ size: params.limit });
				const items = page.items ?? [];
				const lines = items.map((item) => `- ${item.id}: ${item.content}`);
				return {
					content: [
						{
							type: "text",
							text: lines.length ? lines.join("\n") : "No conclusions found.",
						},
					],
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Honcho list_conclusions failed: ${detail}` }],
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "honcho_add_conclusion",
		description:
			"Save a durable conclusion to Honcho. Use target=user for developer-specific observations.",
		parameters: z.object({
			content: z.string().describe("The conclusion to save."),
			target: z.enum(["user"]).default("user"),
		}),
		approval: "write",
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as { content: string; target: "user" };
			const handles = await deps.getHandles(ctx);
			if (!handles) {
				return { content: [{ type: "text", text: "Honcho is not initialized for this session." }] };
			}
			try {
				await userConclusionView(handles).create({
					content: params.content,
					sessionId: handles.session.id,
				});
				return { content: [{ type: "text", text: "Saved to developer memory." }] };
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Failed to save conclusion: ${detail}` }],
					isError: true,
				};
			}
		},
	});

	// Backwards-compatible alias.
	pi.registerTool({
		name: "honcho_remember",
		label: "Honcho Remember",
		description: "Alias for honcho_add_conclusion. Save a durable fact to Honcho.",
		parameters: z.object({
			content: z.string().describe("The fact to remember."),
			target: z.enum(["user"]).default("user"),
		}),
		approval: "write",
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as { content: string; target: "user" };
			const handles = await deps.getHandles(ctx);
			if (!handles) {
				return { content: [{ type: "text", text: "Honcho is not initialized for this session." }] };
			}
			try {
				await userConclusionView(handles).create({
					content: params.content,
					sessionId: handles.session.id,
				});
				return { content: [{ type: "text", text: "Saved to developer memory." }] };
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Failed to save memory: ${detail}` }],
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "honcho_delete_conclusion",
		label: "Honcho Delete Conclusion",
		description: "Delete a durable conclusion from Honcho by ID. Use honcho_list_conclusions to find the ID.",
		parameters: z.object({
			id: z.string().describe("The conclusion ID to delete."),
			target: z.enum(["user"]).default("user"),
		}),
		approval: "write",
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as { id: string; target: "user" };
			const handles = await deps.getHandles(ctx);
			if (!handles) {
				return { content: [{ type: "text", text: "Honcho is not initialized for this session." }] };
			}
			try {
				const conclusionScope = userConclusionView(handles);
				await conclusionScope.get(params.id);
				await conclusionScope.delete(params.id);
				return { content: [{ type: "text", text: `Deleted conclusion ${params.id}` }] };
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Failed to delete conclusion: ${detail}` }],
					isError: true,
				};
			}
		},
	});
	pi.registerTool({
		name: "honcho_set_config",
		label: "Honcho Set Config",
		description:
			"Update a Honcho plugin configuration field in $HONCHO_CONFIG_DIR/config.json or ~/.honcho/config.json. Dangerous changes (workspace, endpoint) require confirm=true.",
		parameters: z.object({
			field: z.enum([
				"peerName",
				"aiPeer",
				"workspace",
				"sessionStrategy",
				"sessionPeerPrefix",
				"observationMode",
				"reasoningLevel",
				"saveMessages",
				"endpoint.environment",
				"endpoint.baseUrl",
				"messageUpload.maxUserTokens",
				"messageUpload.maxAssistantTokens",
				"messageUpload.summarizeAssistant",
				"contextRefresh.messageThreshold",
				"contextRefresh.ttlSeconds",
				"sessions.set",
				"sessions.remove",
			]),
			value: z.union([z.string(), z.number(), z.boolean(), z.any(), z.null()]),
			confirm: z.boolean().default(false),
		}),
		approval: "write",
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as {
				field: string;
				value: unknown;
				confirm: boolean;
			};
			const DANGEROUS_FIELDS = new Set(["workspace", "endpoint.environment", "endpoint.baseUrl"]);
			if (DANGEROUS_FIELDS.has(params.field) && !params.confirm) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: false,
									requiresConfirm: true,
									message: `${params.field} is a dangerous change. Pass confirm=true to apply.`,
								},
								null,
								2,
							),
						},
					],
				};
			}

			const fileConfig = resolveConfig(ctx.cwd);
			const patch: Partial<HonchoExtensionConfig> = {};
			const nested = (base: Record<string, unknown>, key: string, val: unknown): void => {
				base[key] = val;
			};

			try {
				switch (params.field) {
					case "peerName":
						patch.peerName = String(params.value);
						saveRootField("peerName", patch.peerName);
						break;
					case "aiPeer":
						patch.aiPeer = String(params.value);
						saveRootField("aiPeer", patch.aiPeer);
						break;
					case "workspace":
						patch.workspace = String(params.value);
						saveRootField("workspace", patch.workspace);
						break;
					case "sessionStrategy":
						patch.sessionStrategy = String(params.value) as HonchoSessionStrategy;
						saveRootField("sessionStrategy", patch.sessionStrategy);
						break;
					case "sessionPeerPrefix":
						patch.sessionPeerPrefix = Boolean(params.value);
						saveRootField("sessionPeerPrefix", patch.sessionPeerPrefix);
						break;
					case "observationMode":
						patch.observationMode = String(params.value) as HonchoObservationMode;
						saveRootField("observationMode", patch.observationMode);
						break;
					case "reasoningLevel":
						patch.reasoningLevel = String(params.value) as HonchoReasoningLevel;
						saveRootField("reasoningLevel", patch.reasoningLevel);
						break;
					case "saveMessages":
						patch.saveMessages = Boolean(params.value);
						saveRootField("saveMessages", patch.saveMessages);
						break;
					case "endpoint.environment": {
						const env = String(params.value) === "platform" ? "production" : String(params.value);
						patch.endpoint = { ...fileConfig.endpoint, environment: env as HonchoEnvironment, baseUrl: undefined };
						saveRootField("endpoint", patch.endpoint);
						break;
					}
					case "endpoint.baseUrl": {
						patch.endpoint = { ...fileConfig.endpoint, baseUrl: String(params.value), environment: undefined };
						saveRootField("endpoint", patch.endpoint);
						break;
					}
					case "messageUpload.maxUserTokens":
						patch.messageUpload = {
							...fileConfig.messageUpload,
							maxUserTokens: params.value === null ? undefined : Number(params.value),
						};
						saveRootField("messageUpload", patch.messageUpload);
						break;
					case "messageUpload.maxAssistantTokens":
						patch.messageUpload = {
							...fileConfig.messageUpload,
							maxAssistantTokens: params.value === null ? undefined : Number(params.value),
						};
						saveRootField("messageUpload", patch.messageUpload);
						break;
					case "messageUpload.summarizeAssistant":
						patch.messageUpload = { ...fileConfig.messageUpload, summarizeAssistant: Boolean(params.value) };
						saveRootField("messageUpload", patch.messageUpload);
						break;
					case "contextRefresh.messageThreshold":
						patch.contextRefresh = { ...fileConfig.contextRefresh, messageThreshold: Number(params.value) };
						saveRootField("contextRefresh", patch.contextRefresh);
						break;
					case "contextRefresh.ttlSeconds":
						patch.contextRefresh = { ...fileConfig.contextRefresh, ttlSeconds: Number(params.value) };
						saveRootField("contextRefresh", patch.contextRefresh);
						break;
					case "sessions.set": {
						const obj = params.value as Record<string, unknown>;
						if (typeof obj?.path !== "string" || typeof obj?.name !== "string") {
							return {
								content: [{ type: "text", text: "sessions.set requires {path, name}" }],
								isError: true,
							};
						}
						const sessions = { ...(readHonchoConfig().sessions ?? {}) };
						sessions[obj.path] = obj.name;
						saveRootField("sessions", sessions);
						break;
					}
					case "sessions.remove": {
						const obj = params.value as Record<string, unknown>;
						if (typeof obj?.path !== "string") {
							return {
								content: [{ type: "text", text: "sessions.remove requires {path}" }],
								isError: true,
							};
						}
						const sessions = { ...(readHonchoConfig().sessions ?? {}) };
						delete sessions[obj.path];
						saveRootField("sessions", sessions);
						break;
					}
					default:
						return {
							content: [{ type: "text", text: `Unknown field: ${params.field}` }],
							isError: true,
						};
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ success: true, field: params.field, value: params.value }, null, 2),
						},
					],
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Failed to update config: ${detail}` }],
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "honcho_get_config",
		label: "Honcho Get Config",
		description: "View the current Honcho configuration and connection status.",
		parameters: z.object({}),
		async execute(_id, _rawParams, _signal, _onUpdate, ctx) {
			const config = resolveConfig(ctx.cwd);
			const handles = await deps.getHandles(ctx).catch(() => null);
			const status = handles
				? {
						workspace: handles.workspaceId,
						session: handles.sessionId,
						developerPeer: handles.userPeerId,
						aiPeer: handles.aiPeerId,
				  }
				: { connected: false };
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								enabled: config.enabled,
								workspace: config.workspace,
								peerName: config.peerName,
								aiPeer: config.aiPeer,
								sessionStrategy: config.sessionStrategy,
								sessionPeerPrefix: config.sessionPeerPrefix,
								observationMode: config.observationMode,
								reasoningLevel: config.reasoningLevel,
								saveMessages: config.saveMessages,
								url: config.url,
								status,
							},
							null,
							2,
						),
					},
				],
			};
		},
	});
}
