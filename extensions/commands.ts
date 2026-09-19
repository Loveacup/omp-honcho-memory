import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { HonchoHandles } from "./client.js";
import { resolveConfig, isConfigured } from "./config.js";

export interface CommandRegistryDependencies {
	getHandles: (ctx: ExtensionContext) => Promise<HonchoHandles | null>;
}

export function registerCommands(pi: ExtensionAPI, deps: CommandRegistryDependencies): void {
	pi.registerCommand("honcho-status", {
		description: "Show Honcho connection status, active peers, and session mapping.",
		async handler(_args, ctx) {
			const handles = await deps.getHandles(ctx);
			if (!handles) {
				ctx.ui.notify("Honcho is not initialized for this session.", "warning");
				return;
			}
			const sessionUrl = `${handles.config.url.replace(/\/v\d+$/, "").replace(/\/$/, "")}/sessions/${handles.sessionId}`;
			const lines = [
				`Workspace: ${handles.workspaceId}`,
				`Session: ${handles.sessionId}`,
				`Developer peer: ${handles.userPeerId}`,
				`AI peer: ${handles.aiPeerId}`,
				`Observation mode: ${handles.config.observationMode}`,
				`Session strategy: ${handles.config.sessionStrategy}`,
				`Endpoint: ${handles.config.url}`,
				`Session link: ${sessionUrl}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("honcho-config", {
		description: "Show current Honcho configuration.",
		async handler(_args, ctx) {
			const config = resolveConfig(ctx.cwd);
			const lines = [
				`enabled: ${config.enabled}`,
				`url: ${config.url}`,
				`workspace: ${config.workspace}`,
				`peerName: ${config.peerName}`,
				`aiPeer: ${config.aiPeer}`,
				`observationMode: ${config.observationMode}`,
				`contextTokens: ${config.contextTokens}`,
				`commitEveryNTurns: ${config.commitEveryNTurns}`,
				`contextRefresh: ttlSeconds=${config.contextRefresh.ttlSeconds}, messageThreshold=${config.contextRefresh.messageThreshold}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("honcho-setup", {
		description: "Validate Honcho configuration and report missing required fields.",
		async handler(_args, ctx) {
			const config = resolveConfig(ctx.cwd);
			const issues: string[] = [];
			if (!config.apiKey) issues.push("HONCHO_API_KEY is missing.");
			if (!config.workspace) issues.push("HONCHO_WORKSPACE is missing.");
			if (!config.peerName) issues.push("HONCHO_PEER_NAME is missing.");
			if (!isConfigured(config)) {
				ctx.ui.notify(`Honcho is not configured:\n${issues.join("\n")}`, "warning");
				return;
			}
			const handles = await deps.getHandles(ctx);
			if (!handles) {
				ctx.ui.notify("Configuration looks valid but Honcho client could not be initialized.", "warning");
				return;
			}
			ctx.ui.notify(
				`Honcho is configured and connected.\nWorkspace: ${handles.workspaceId}\nSession: ${handles.sessionId}`,
				"success",
			);
		},
	});
}
