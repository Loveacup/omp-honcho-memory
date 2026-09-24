import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHonchoHandles, userConclusionView, type HonchoHandles } from "../extensions/client.js";
import { isConfigured, resolveConfigForHost } from "../extensions/config.js";
import { formatRawRecall } from "../extensions/raw-recall.js";
import { searchWorkspaceMessages } from "../extensions/raw-search.js";
import { buildSessionKey } from "../extensions/session-key.js";

const dryRun = process.argv.includes("--dry-run");
const host = "claude_code" as const;

function textResult(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError: true } : {}),
	};
}

let cachedHandles: Promise<HonchoHandles | null> | null = null;
function handles(): Promise<HonchoHandles | null> {
	if (cachedHandles) return cachedHandles;
	cachedHandles = (async () => {
		if (dryRun) return null;
		const cwd = process.cwd();
		const config = resolveConfigForHost(host, cwd);
		if (!isConfigured(config)) return null;
		const sessionKey = `claude-code-${buildSessionKey({
			sessionStrategy: config.sessionStrategy,
			sessionPeerPrefix: config.sessionPeerPrefix,
			peerName: config.peerName,
			cwd,
			sessionId: `mcp-${process.pid}`,
		})}`;
		return createHonchoHandles({ config, sessionKey });
	})();
	return cachedHandles;
}

const server = new McpServer({ name: "honcho-memory", version: "0.4.0" });

server.registerTool(
	"honcho_search",
	{
		description: "Search raw stored messages in the configured Honcho workspace with bounded provenance-preserving output.",
		inputSchema: {
			query: z.string().min(1).describe("The search query."),
			target: z.enum(["user", "all"]).default("all"),
		},
	},
	async ({ query, target }) => {
		if (dryRun) return textResult("Network access is disabled in dry-run mode.", true);
		const config = resolveConfigForHost(host, process.cwd());
		const result = await searchWorkspaceMessages(
			{ apiKey: config.apiKey, baseUrl: config.url, workspaceId: config.workspace },
			query,
			{ target, userPeerId: config.peerName },
		);
		try {
			return textResult(formatRawRecall(result), result.isError);
		} catch {
			return textResult("Honcho search output exceeded its safe budget.", true);
		}
	},
);

server.registerTool(
	"honcho_list_conclusions",
	{
		description: "List current durable conclusions stored for the user, including IDs needed for correction or revocation.",
		inputSchema: {
			target: z.literal("user").default("user"),
			limit: z.number().int().min(1).max(100).default(20),
		},
	},
	async ({ limit }) => {
		const runtime = await handles();
		if (!runtime) return textResult(dryRun ? "Network access is disabled in dry-run mode." : "Honcho is not configured.", true);
		try {
			const page = await userConclusionView(runtime).list({ size: limit });
			const items = (page.items ?? []).map((item: { id?: string; content?: string }) => ({
				id: item.id ?? null,
				content: item.content ?? "",
			}));
			return textResult(JSON.stringify({ conclusions: items }));
		} catch {
			return textResult("Honcho list_conclusions failed.", true);
		}
	},
);

server.registerTool(
	"honcho_add_conclusion",
	{
		description: "Save an explicit durable conclusion about the user. Use this for remember or correction requests.",
		inputSchema: {
			content: z.string().min(1).describe("The conclusion to save."),
			target: z.literal("user").default("user"),
		},
	},
	async ({ content }) => {
		const runtime = await handles();
		if (!runtime) return textResult(dryRun ? "Network access is disabled in dry-run mode." : "Honcho is not configured.", true);
		try {
			await userConclusionView(runtime).create({ content, sessionId: runtime.session.id });
			return textResult("Conclusion saved.");
		} catch {
			return textResult("Failed to save conclusion.", true);
		}
	},
);

server.registerTool(
	"honcho_delete_conclusion",
	{
		description: "Delete a durable conclusion by ID. For replacement, delete the old conclusion and add the corrected one.",
		inputSchema: {
			id: z.string().min(1).describe("The conclusion ID to delete."),
			target: z.literal("user").default("user"),
		},
	},
	async ({ id }) => {
		const runtime = await handles();
		if (!runtime) return textResult(dryRun ? "Network access is disabled in dry-run mode." : "Honcho is not configured.", true);
		const view = userConclusionView(runtime);
		let conclusion;
		try {
			conclusion = await view.get(id);
		} catch {
			return textResult("Refusing to delete a conclusion not found in the configured user scope.", true);
		}
		if (conclusion.observedId !== runtime.userPeerId) {
			return textResult("Refusing to delete a conclusion outside the configured user scope.", true);
		}
		try {
			await view.delete(id);
			return textResult(`Deleted conclusion ${id}`);
		} catch {
			return textResult("Failed to delete conclusion.", true);
		}
	},
);

try {
	await server.connect(new StdioServerTransport());
} catch (error) {
	const kind = error instanceof Error ? error.name : "Error";
	process.stderr.write(`honcho-memory MCP failed: ${kind}\n`);
	process.exitCode = 1;
}
