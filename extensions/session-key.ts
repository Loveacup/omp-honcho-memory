import { basename } from "node:path";
import { execSync } from "node:child_process";
import type { HonchoSessionStrategy } from "./config.js";

export function sanitizeForSessionName(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

export function deriveGitBranchLabel(cwd: string): string | null {
	try {
		const result = execSync("git branch --show-current", {
			cwd,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "ignore"],
		});
		return result.trim();
	} catch {
		return null;
	}
}

export function buildSessionKey(params: {
	sessionStrategy: HonchoSessionStrategy;
	sessionPeerPrefix: boolean;
	peerName: string;
	cwd: string;
	sessionId: string;
	sessions?: Record<string, string>;
}): string {
	// Manual overrides only apply to per-directory strategy.
	if (params.sessionStrategy === "per-directory" && params.sessions?.[params.cwd]) {
		return sanitizeForSessionName(params.sessions[params.cwd]);
	}

	const usePrefix = params.sessionPeerPrefix;
	const peerPart = sanitizeForSessionName(params.peerName);
	const repoPart = sanitizeForSessionName(basename(params.cwd));
	const base = usePrefix ? `${peerPart}-${repoPart}` : repoPart;

	switch (params.sessionStrategy) {
		case "git-branch": {
			const branch = deriveGitBranchLabel(params.cwd);
			if (branch) {
				const branchPart = sanitizeForSessionName(branch);
				return `${base}-${branchPart}`;
			}
			return base;
		}
		case "chat-instance": {
			const instancePart = sanitizeForSessionName(params.sessionId);
			return usePrefix ? `${peerPart}-chat-${instancePart}` : `chat-${instancePart}`;
		}
		case "per-directory":
		default:
			return base;
	}
}
