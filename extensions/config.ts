import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HonchoHost } from "../core/source.js";


export type HonchoSessionStrategy =
	| "per-directory"
	| "git-branch"
	| "chat-instance";

export type HonchoObservationMode = "unified" | "directional";
export type HonchoReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";
export type HonchoEnvironment = "production" | "local";

export interface HonchoEndpointConfig {
	environment?: HonchoEnvironment;
	baseUrl?: string;
}

export interface HonchoMessageUploadConfig {
	maxUserTokens?: number;
	maxAssistantTokens?: number;
	summarizeAssistant?: boolean;
}

export interface HonchoExtensionConfig {
	enabled: boolean;
	url: string;
	apiKey: string;
	workspace: string;
	peerName: string;
	aiPeer: string;
	sessionStrategy: HonchoSessionStrategy;
	sessionPeerPrefix: boolean;
	observationMode: HonchoObservationMode;
	reasoningLevel: HonchoReasoningLevel;
	contextTokens: number;
	commitEveryNTurns: number;
	saveMessages: boolean;
	injectPerPrompt: boolean;
	endpoint: HonchoEndpointConfig;
	messageUpload: HonchoMessageUploadConfig;
	contextRefresh: {
		messageThreshold: number;
		ttlSeconds: number;
	};
}

const DEFAULTS: HonchoExtensionConfig = {
	enabled: false,
	url: "https://api.honcho.dev",
	apiKey: "",
	workspace: "oh-my-pi",
	peerName: "user",
	aiPeer: "ai-oh-my-pi",
	sessionStrategy: "per-directory",
	sessionPeerPrefix: true,
	observationMode: "unified",
	reasoningLevel: "low",
	contextTokens: 1200,
	commitEveryNTurns: 4,
	saveMessages: true,
	injectPerPrompt: true,
	endpoint: { environment: "production" },
	messageUpload: {},
	contextRefresh: {
		messageThreshold: 30,
		ttlSeconds: 300,
	},
};

function expandEnv(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => process.env[key] ?? "");
}



function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const result: Partial<T> = {};
	for (const key of Object.keys(obj)) {
		const value = obj[key];
		if (value !== undefined) {
			(result as Record<string, unknown>)[key] = value;
		}
	}
	return result;
}

const DEFAULT_HOST: HonchoHost = "omp";
// ============================================
// Config file: $HONCHO_CONFIG_DIR/config.json or ~/.honcho/config.json
// Following the official claude-honcho / pi-honcho-memory pattern
// ============================================

function honchoConfigPath(): string {
	const override = process.env.HONCHO_CONFIG_DIR?.trim();
	if (override) return join(resolve(override), "config.json");
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
	return join(home, ".honcho", "config.json");
}

/** Per-host / per-directory overrides within config.json */
interface HonchoScopeConfig {
	enabled?: boolean;
	apiKey?: string;
	url?: string;
	workspace?: string;
	aiPeer?: string;
	sessionStrategy?: HonchoSessionStrategy;
	sessionPeerPrefix?: boolean;
	observationMode?: HonchoObservationMode;
	reasoningLevel?: HonchoReasoningLevel;
	contextTokens?: number;
	commitEveryNTurns?: number;
	saveMessages?: boolean;
	injectPerPrompt?: boolean;
	endpoint?: HonchoEndpointConfig;
	messageUpload?: HonchoMessageUploadConfig;
	contextRefresh?: {
		messageThreshold?: number;
		ttlSeconds?: number;
	};
}

/** Raw shape of ~/.honcho/config.json on disk */
interface HonchoFileConfig {
	enabled?: boolean;
	apiKey?: string;
	peerName?: string;
	url?: string;
	baseUrl?: string;
	workspace?: string;
	aiPeer?: string;
	sessionStrategy?: HonchoSessionStrategy;
	sessionPeerPrefix?: boolean;
	observationMode?: HonchoObservationMode;
	reasoningLevel?: HonchoReasoningLevel;
	contextTokens?: number;
	commitEveryNTurns?: number;
	saveMessages?: boolean;
	injectPerPrompt?: boolean;
	endpoint?: HonchoEndpointConfig;
	messageUpload?: HonchoMessageUploadConfig;
	contextRefresh?: {
		messageThreshold?: number;
		ttlSeconds?: number;
	};
	hosts?: Record<string, HonchoScopeConfig>;
	/** Per-directory overrides — longest prefix match of absolute path wins */
	directories?: Record<string, HonchoScopeConfig>;
	/** Manual session name overrides for per-directory strategy */
	sessions?: Record<string, string>;
}

export function readHonchoConfig(): HonchoFileConfig {
	if (!existsSync(honchoConfigPath())) return {};
	try {
		const text = readFileSync(honchoConfigPath(), "utf8");
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as HonchoFileConfig;
		}
	} catch {}
	return {};
}

function ensureHonchoConfigDir(): void {
	const dir = join(honchoConfigPath(), "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

export function saveConfig(patch: Partial<HonchoFileConfig>): void {
	ensureHonchoConfigDir();
	const existing = readHonchoConfig();
	const merged = { ...existing, ...patch };
	writeFileSync(honchoConfigPath(), JSON.stringify(merged, null, 2));
}

export function saveRootField(field: keyof HonchoFileConfig, value: unknown): void {
	ensureHonchoConfigDir();
	const existing = readHonchoConfig();
	(existing as Record<string, unknown>)[field] = value;
	writeFileSync(honchoConfigPath(), JSON.stringify(existing, null, 2));
}

/**
 * Find the best matching directory entry for cwd.
 * Longest absolute-path prefix that is an ancestor of cwd wins.
 */
function matchDirectory(
	cwd: string,
	directories: Record<string, HonchoScopeConfig>,
): HonchoScopeConfig {
	const resolvedCwd = resolve(cwd);
	let bestMatch: { config: HonchoScopeConfig; path: string } | null = null;

	for (const [key, config] of Object.entries(directories)) {
		const resolvedKey = resolve(key);
		if (!resolvedCwd.startsWith(resolvedKey)) continue;
		// Must be an exact match or a directory boundary (followed by /)
		if (resolvedCwd.length > resolvedKey.length && resolvedCwd[resolvedKey.length] !== "/") continue;
		if (!bestMatch || resolvedKey.length > bestMatch.path.length) {
			bestMatch = { config, path: resolvedKey };
		}
	}

	return bestMatch?.config ?? {};
}

function honchoConfigToPartial(config: HonchoScopeConfig): Partial<HonchoExtensionConfig> {
	const result: Partial<HonchoExtensionConfig> = stripUndefined({
		enabled: config.enabled,
		apiKey: config.apiKey,
		url: config.url,
		workspace: config.workspace,
		aiPeer: config.aiPeer,
		sessionStrategy: config.sessionStrategy,
		sessionPeerPrefix: config.sessionPeerPrefix,
		observationMode: config.observationMode,
		reasoningLevel: config.reasoningLevel,
		contextTokens: config.contextTokens,
		commitEveryNTurns: config.commitEveryNTurns,
		saveMessages: config.saveMessages,
		injectPerPrompt: config.injectPerPrompt,
		endpoint: config.endpoint,
		messageUpload: config.messageUpload,
	});
	if (config.contextRefresh) {
		result.contextRefresh = {
			messageThreshold: config.contextRefresh.messageThreshold ?? DEFAULTS.contextRefresh.messageThreshold,
			ttlSeconds: config.contextRefresh.ttlSeconds ?? DEFAULTS.contextRefresh.ttlSeconds,
		};
	}
	if (config.endpoint) {
		result.endpoint = {
			environment: config.endpoint.environment ?? DEFAULTS.endpoint.environment,
			baseUrl: config.endpoint.baseUrl,
		};
	}
	if (config.messageUpload) {
		result.messageUpload = { ...config.messageUpload };
	}
	return result;
}

// ============================================
// Resolve
// ============================================

export function resolveConfigForHost(host: HonchoHost, cwd: string): HonchoExtensionConfig {
	const honchoFile = readHonchoConfig();
	const hostExists = Object.prototype.hasOwnProperty.call(honchoFile.hosts ?? {}, host);
	const hostScoped = honchoFile.hosts?.[host] ?? {};
	const dirScoped = matchDirectory(cwd, honchoFile.directories ?? {});

	const envHoncho: Partial<HonchoExtensionConfig> = stripUndefined({
		apiKey: process.env.HONCHO_API_KEY,
		url: process.env.HONCHO_URL,
		workspace: process.env.HONCHO_WORKSPACE,
		peerName: process.env.HONCHO_PEER_NAME ?? process.env.HONCHO_USERNAME,
		aiPeer: process.env.HONCHO_AI_PEER,
	});

	// Merge: later sources override earlier ones
	const merged = {
		...DEFAULTS,
		// Config file global fields
		...stripUndefined({
			enabled: honchoFile.enabled,
			apiKey: honchoFile.apiKey,
			peerName: honchoFile.peerName,
			url: honchoFile.url ?? honchoFile.baseUrl,
			workspace: honchoFile.workspace,
			aiPeer: honchoFile.aiPeer,
			sessionStrategy: honchoFile.sessionStrategy,
			sessionPeerPrefix: honchoFile.sessionPeerPrefix,
			observationMode: honchoFile.observationMode,
			reasoningLevel: honchoFile.reasoningLevel,
			contextTokens: honchoFile.contextTokens,
			commitEveryNTurns: honchoFile.commitEveryNTurns,
			saveMessages: honchoFile.saveMessages,
			injectPerPrompt: honchoFile.injectPerPrompt,
			endpoint: honchoFile.endpoint,
			messageUpload: honchoFile.messageUpload,
			contextRefresh: honchoFile.contextRefresh,
		}),
		// A declared host defaults on only when neither the host nor the root
		// explicitly chooses enabled/disabled.
		...(hostExists && hostScoped.enabled === undefined && honchoFile.enabled === undefined ? { enabled: true } : {}),
		...honchoConfigToPartial(hostScoped),
		// Config file directories block
		...honchoConfigToPartial(dirScoped),
		// Environment variables (highest precedence)
		...envHoncho,
	};

	if (merged.apiKey) merged.apiKey = expandEnv(merged.apiKey);
	if (merged.url) merged.url = expandEnv(merged.url);
	merged.url = getHonchoBaseUrl(merged as HonchoExtensionConfig);

	// Preserve exact configured Peer IDs (including case and explicit prefixes).
	merged.contextRefresh = {
		messageThreshold: merged.contextRefresh?.messageThreshold ?? DEFAULTS.contextRefresh.messageThreshold,
		ttlSeconds: merged.contextRefresh?.ttlSeconds ?? DEFAULTS.contextRefresh.ttlSeconds,
	};
	merged.endpoint = {
		environment: merged.endpoint?.environment ?? DEFAULTS.endpoint.environment,
		baseUrl: merged.endpoint?.baseUrl,
	};
	merged.messageUpload = merged.messageUpload ?? {};
	return merged as HonchoExtensionConfig;
}

export function resolveConfig(cwd: string): HonchoExtensionConfig {
	return resolveConfigForHost(DEFAULT_HOST, cwd);
}

export function getSessionOverride(cwd: string): string | null {
	const file = readHonchoConfig();
	if (!file.sessions) return null;
	return file.sessions[cwd] || null;
}

const HONCHO_BASE_URLS: Record<HonchoEnvironment, string> = {
	production: "https://api.honcho.dev",
	local: "http://127.0.0.1:8000",
};

export function getHonchoBaseUrl(config: HonchoExtensionConfig): string {
	if (config.endpoint?.baseUrl) return config.endpoint.baseUrl;
	// An explicit url (config file or HONCHO_URL) beats the default environment.
	if (config.url && config.url !== DEFAULTS.url) return config.url;
	if (config.endpoint?.environment) return HONCHO_BASE_URLS[config.endpoint.environment];
	return config.url || HONCHO_BASE_URLS.production;
}

export function isConfigured(config: HonchoExtensionConfig): boolean {
	return Boolean(config.enabled && config.apiKey && config.workspace);
}
