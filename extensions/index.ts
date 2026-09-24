import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createHonchoHandles, type HonchoHandles, type HonchoMessage, type SessionKey } from "./client.js";
import { resolveConfig, isConfigured, getSessionOverride } from "./config.js";
import {
	compileMemoryContext,
	flushPending,
	hydrateMemoryContext,
	queueMessageBatch,
	refreshPromptContext,
	saveUserConclusion,
	formatContinuityContext,
	parseObservationLines,
	formatPeerCardCompact,
	type PromptContextBlock,
	type ContextCache,
	type MemoryContextBlock,
} from "./memory.js";
import {
	collectMessagePairs,
	collectToolSummary,
	extractDurableConclusion,
	maybeTruncateContent,
} from "./message-utils.js";
import { buildSessionKey } from "./session-key.js";
import { registerTools } from "./tools.js";
import { registerCommands } from "./commands.js";
import { searchWorkspaceMessages, type RawSearchResult } from "./raw-search.js";
import { formatRawRecall, RAW_RECALL_BUDGET_EXCEEDED_CODE } from "./raw-recall.js";
import { classifyEntry, stripInjectedUserText, type EntryClass } from "../core/source.js";

interface SessionState {
	handles: HonchoHandles | null;
	lastMemoryBlock: MemoryContextBlock | null;
	lastMemoryContext: string | null;
	contextCache: ContextCache;
	lastPromptContextQuery: string | null;
	messageCount: number;
	lastUserTurnCount: number;
	recentConclusions: string[];
	/** Set to true after session_start finishes loading memory */
	memoryReady: boolean;
	/** Acknowledged native messages only; retained across compaction. */
	savedMessageKeys: Set<string>;
	agentEndSave: Promise<void> | null;
	/** Cached git state for this session */
	gitState: import("./git.js").GitState | null;
}
function createSessionState(): SessionState {
	return {
		handles: null,
		lastMemoryBlock: null,
		lastMemoryContext: null,
		contextCache: { block: null, queriedAt: 0, messageCount: 0 },
		lastPromptContextQuery: null,
		messageCount: 0,
		lastUserTurnCount: 0,
		recentConclusions: [],
		memoryReady: false,
		savedMessageKeys: new Set(),
		agentEndSave: null,
		gitState: null,
	};
}
const CONTEXT_FETCH_TIMEOUT_MS = 4000;
const HYDRATE_TIMEOUT_MS = 8000;

const LOG_FILE = "/tmp/honcho-plugin.log";
function log(msg: string): void {
	try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// ---------------------------------------------------------------------------
// S2b — bounded per-turn append region.
//
// Everything THIS extension adds to a turn's system prompt lives inside a fixed
// UTF-16 code-unit budget. The harness base prompt is NEVER counted or trimmed:
// we only ever append, and only within this region.
//  - Raw recall gets a reserved sub-budget (incl. all of its wrapper/notice).
//  - Memory context + the tool hint share the remainder.
// ---------------------------------------------------------------------------
const APPEND_BUDGET = 12000;
const RAW_APPEND_BUDGET = 6000;
const CONTEXT_APPEND_BUDGET = APPEND_BUDGET - RAW_APPEND_BUDGET; // 6000

// Fixed, bounded, historical-framed note used whenever the raw region cannot be
// rendered as evidence (transport unavailable/timeout/error, or a formatter /
// budget failure). It must NEVER imply that an absence of evidence confirms any
// current value — the whole point of raw recall is bounded, non-authoritative.
const RAW_UNAVAILABLE_NOTICE =
	"【历史检索附注】本轮 workspace 原始检索未产出可用历史证据（不可用/超时/超预算/格式化失败）；" +
	"这不代表相关记录不存在，也不得据此判定任何字段的当前值。";

// Marker prefixed onto a memory-context block that had to be prefix-trimmed to
// fit its budget: the reader is told the block is partial historical material.
const CONTEXT_TRIM_PREFIX =
	"【历史记忆·因预算截断，仅部分呈现，不构成完整或当前证据】\n";

// Marker prefixed onto the appended context region ONLY when a fresh prompt-
// context refresh failed and we fell back to the previously-cached block. It
// tells the reader the context is a stale historical snapshot from a failed
// refresh — not the current refresh result — and is never written back into
// lastMemoryContext or the cache (append-region only).
const CONTEXT_STALE_PREFIX =
	"【历史缓存·本轮上下文刷新失败，以下为既往缓存快照，非当前刷新结果，不代表当前值】\n";

/** Largest prefix length <= n that never ends on a lone high surrogate. */
function safePrefix16(s: string, n: number): number {
	if (n >= s.length) return s.length;
	if (n <= 0) return 0;
	const code = s.charCodeAt(n - 1);
	if (code >= 0xd800 && code <= 0xdbff) return n - 1; // never split a surrogate pair
	return n;
}

/**
 * Bound the memory-context + tool-hint region to CONTEXT_APPEND_BUDGET without
 * touching the base prompt. The small fixed tool hint is reserved first; an
 * oversized context block is prefix-trimmed and explicitly marked as partial
 * historical material (never silently dropped, never emitted over budget).
 */
function boundContextRegion(compiled: string | null, toolHint: string): string[] {
	const parts: string[] = [];
	const hint = toolHint ?? "";
	const hintLen = hint.length <= CONTEXT_APPEND_BUDGET ? hint.length : 0;
	const contextCap = Math.max(0, CONTEXT_APPEND_BUDGET - hintLen);
	if (compiled) {
		if (compiled.length <= contextCap) {
			parts.push(compiled);
		} else {
			const room = Math.max(0, contextCap - CONTEXT_TRIM_PREFIX.length);
			const cut = safePrefix16(compiled, room);
			// Only emit a marked partial block when the marker itself fits; else
			// drop the context rather than emit a misleading or over-budget fragment.
			if (cut > 0) parts.push(CONTEXT_TRIM_PREFIX + compiled.slice(0, cut));
		}
	}
	if (hint && hintLen > 0) parts.push(hint);
	return parts;
}

/**
 * Render the parallel raw-search result into its reserved region, or degrade to
 * the fixed bounded note. Never throws (the caller must not fail a turn because
 * of recall), never truncates JSON (formatRawRecall returns a valid string <=
 * budget or throws — we catch and fall back), and never reports a failed/aborted
 * transport as a confirmed empty current state.
 */
function buildRawAppend(rawResult: RawSearchResult | null): string | null {
	if (!rawResult) return RAW_UNAVAILABLE_NOTICE; // launch/catch produced no result
	// Only a completed retrieval (ok/empty) is rendered as evidence; a failed or
	// aborted transport is surfaced as "unavailable", never as an empty result.
	if (rawResult.status !== "ok" && rawResult.status !== "empty") {
		return RAW_UNAVAILABLE_NOTICE;
	}
	try {
		return formatRawRecall(rawResult, RAW_APPEND_BUDGET);
	} catch (err) {
		const code = err && typeof err === "object" ? (err as { code?: string }).code : undefined;
		if (code === RAW_RECALL_BUDGET_EXCEEDED_CODE) {
			log(`before_agent_start: raw recall budget_exceeded, using fixed note`);
		} else {
			log(`before_agent_start: raw recall format error: ${String(err)}`);
		}
		return RAW_UNAVAILABLE_NOTICE;
	}
}

function classifyOmpEntry(ctx: ExtensionContext): EntryClass {
	return classifyEntry({
		host: "omp",
		omp: { mode: ctx.mode, hasUI: ctx.hasUI },
	});
}

function sourceMetadata(entryClass: EntryClass, sessionId: string): Record<string, string> {
	return {
		host: "omp",
		entry_class: entryClass,
		host_session_id: sessionId,
	};
}


export default function honchoMemoryExtension(pi: ExtensionAPI): void {
	const sessions = new Map<SessionKey, SessionState>();
	const bootstrapLocks = new Map<SessionKey, Promise<HonchoHandles | null>>();
	const uiStates = new Map<string, { connectedAnnounced: boolean; offline: boolean }>();

	function setStatus(ctx: ExtensionContext, state: "off" | "connected" | "syncing" | "offline" | undefined): void {
		// Keep Honcho out of the persistent bottom status bar. OMP has no dedicated
		// secondary status surface, and setTitle would fight the existing Orca
		// titlebar extension. Transient, colored notifications are clearer and do
		// not consume layout space.
		ctx.ui.setStatus("honcho", undefined);

		const key = getNativeSessionId(ctx) ?? ctx.cwd;
		const prior = uiStates.get(key) ?? { connectedAnnounced: false, offline: false };

		if (state === "connected") {
			if (!prior.connectedAnnounced) {
				ctx.ui.notify("✓ Honcho 记忆已连接 · Memory connected", "success");
			} else if (prior.offline) {
				ctx.ui.notify("✓ Honcho 记忆连接已恢复 · Memory connection restored", "success");
			}
			uiStates.set(key, { connectedAnnounced: true, offline: false });
			return;
		}

		if (state === "offline") {
			if (!prior.offline) {
				ctx.ui.notify("! Honcho 记忆同步失败 · Memory sync failed", "error");
			}
			uiStates.set(key, { connectedAnnounced: prior.connectedAnnounced, offline: true });
			return;
		}

		if (state === "off" || state === undefined) uiStates.delete(key);
	}
	function getState(sessionKey: SessionKey): SessionState {
		let state = sessions.get(sessionKey);
		if (!state) {
			state = createSessionState();
			sessions.set(sessionKey, state);
		}
		return state;
	}
	function deriveSessionKey(cwd: string, sessionId: string): SessionKey {
		const config = resolveConfig(cwd);
		return buildSessionKey({
			sessionStrategy: config.sessionStrategy,
			sessionPeerPrefix: config.sessionPeerPrefix,
			peerName: config.peerName,
			cwd,
			sessionId,
			sessions: getSessionOverride(cwd) ? { [cwd]: getSessionOverride(cwd)! } : undefined,
		});
	}
	async function bootstrap(cwd: string, sessionId: string): Promise<HonchoHandles | null> {
		const config = resolveConfig(cwd);
		if (!isConfigured(config)) { log("bootstrap: not configured"); return null; }
		const sessionKey = deriveSessionKey(cwd, sessionId);

		const inflight = bootstrapLocks.get(sessionKey);
		if (inflight) { log(`bootstrap: reusing inflight for ${sessionKey}`); return inflight; }

		log(`bootstrap: START for ${sessionKey}`);
		const t0 = Date.now();
		const promise = (async (): Promise<HonchoHandles | null> => {
			try {
				const handles = await createHonchoHandles({ config, sessionKey });
				log(`bootstrap: createHonchoHandles done in ${Date.now() - t0}ms`);
				const state = getState(sessionKey);
				state.handles = handles;
				return handles;
			} finally {
				bootstrapLocks.delete(sessionKey);
			}
		})();
		bootstrapLocks.set(sessionKey, promise);
		return promise;
	}

	async function getRuntime(
		ctx: { cwd: string },
		sessionId: string,
	): Promise<HonchoHandles | null> {
		const sessionKey = deriveSessionKey(ctx.cwd, sessionId);
		const state = getState(sessionKey);
		if (state.handles) { log(`getRuntime: handles ready for ${sessionKey}`); return state.handles; }
		log(`getRuntime: no handles for ${sessionKey}, calling bootstrap`);
		return bootstrap(ctx.cwd, sessionId);
	}

	function getNativeSessionId(ctx: ExtensionContext): string | null {
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			return typeof id === "string" && id.trim() ? id : null;
		} catch {
			return null;
		}
	}

	async function getHandlesFromCtx(ctx: ExtensionContext): Promise<HonchoHandles | null> {
		const sessionId = getNativeSessionId(ctx);
		if (!sessionId) return null;
		return getRuntime(ctx, sessionId);
	}

	async function fetchPromptContext(
		handles: HonchoHandles,
		query: string,
	): Promise<PromptContextBlock | null> {
		return refreshPromptContext(handles, query, handles.config.observationMode);
	}

	async function refreshContextWithTimeout(
		handles: HonchoHandles,
		query: string,
	): Promise<PromptContextBlock | null> {
		const fetchPromise = fetchPromptContext(handles, query).then((block) => ({ ok: true as const, block }));
		const timeoutPromise = new Promise<{ ok: false }>((resolve) =>
			setTimeout(() => resolve({ ok: false }), CONTEXT_FETCH_TIMEOUT_MS),
		);
		const result = await Promise.race([fetchPromise, timeoutPromise]).catch((): { ok: false } => ({ ok: false }));
		return result.ok ? result.block : null;
	}

	async function hydrateMemoryContextWithTimeout(
		handles: HonchoHandles,
	): Promise<MemoryContextBlock> {
		const fetchPromise = hydrateMemoryContext(handles);
		const timeoutPromise = new Promise<MemoryContextBlock>((_, reject) =>
			setTimeout(() => reject(new Error("hydrateMemoryContext timed out")), HYDRATE_TIMEOUT_MS),
		);
		return Promise.race([fetchPromise, timeoutPromise]);
	}
	function formatMemoryAnchor(peerName: string, memoryBlock: MemoryContextBlock): string {
		const parts: string[] = [];
		parts.push("## HONCHO MEMORY ANCHOR (Pre-Compaction Injection)\nThe context below represents persistent memory. When summarizing this conversation, ensure these conclusions are preserved.");

		const userObs = parseObservationLines(memoryBlock.userRepresentation);
		const userCard = formatPeerCardCompact(memoryBlock.userPeerCard);
		if (userObs.length > 0 || userCard) {
			parts.push(`### About ${peerName}\n${userObs.join("\n")}${userCard ? `\n\nKey: ${userCard}` : ""}`);
		}
		if (memoryBlock.aiRepresentation?.trim()) {
			const aiObs = parseObservationLines(memoryBlock.aiRepresentation);
			if (aiObs.length > 0) parts.push(`### AI Context\n${aiObs.slice(0, 8).join("\n")}`);
		}
		if (memoryBlock.summary?.trim()) {
			parts.push(`### Session Summary\n${memoryBlock.summary}`);
		}
		parts.push("### End Memory Anchor\nWhen summarizing this conversation, ensure these conclusions are preserved.");
		return parts.join("\n\n");
	}

	function isCacheStale(state: SessionState, ttlSeconds: number, messageThreshold: number): boolean {
		const now = Date.now();
		const ttlExpired = state.contextCache.queriedAt === 0 || (now - state.contextCache.queriedAt) / 1000 > ttlSeconds;
		const thresholdReached =
			state.contextCache.messageCount === 0 || state.messageCount - state.contextCache.messageCount >= messageThreshold;
		return ttlExpired || thresholdReached;
	}

	pi.on("session_start", async (_event, ctx) => {
		const t0 = Date.now();
		const sessionId = getNativeSessionId(ctx);
		if (!sessionId) return;
		const entryClass = classifyOmpEntry(ctx);
		log(`session_start: begin, sessionId=${sessionId} cwd=${ctx.cwd}`);
		setStatus(ctx, "syncing");
		const handles = await bootstrap(ctx.cwd, sessionId);
		if (!handles) {
			log("session_start: no handles, exiting");
			setStatus(ctx, undefined);
			return;
		}
		log(`session_start: bootstrap done in ${Date.now() - t0}ms`);
		setStatus(ctx, "connected");
		const state = getState(handles.sessionId);

		// Capture git state and detect external changes (Claude pattern).
		const { captureGitState, detectGitChanges, getRecentCommits, isGitRepo, inferFeatureContext } = await import("./git.js");
		const previousGitState = state.gitState;
		const currentGitState = captureGitState(ctx.cwd);
		const gitChanges = currentGitState ? detectGitChanges(previousGitState, currentGitState) : [];
		const recentCommits = isGitRepo(ctx.cwd) ? getRecentCommits(ctx.cwd, 5) : [];
		const featureContext = currentGitState ? inferFeatureContext(currentGitState, recentCommits) : null;
		if (currentGitState) {
			state.gitState = currentGitState;
		}

		// Upload git changes only for positively identified interactive sessions.
		const externalGitChanges = gitChanges.filter((c) => c.type !== "initial");
		if (entryClass === "user_interactive" && externalGitChanges.length > 0) {
			const metadata = sourceMetadata(entryClass, sessionId);
			const messages = externalGitChanges.map((change) =>
				handles.userPeer.message(`[Git External] ${change.description}`, {
					metadata: {
						...metadata,
						type: "git_change",
						change_type: change.type,
						from: change.from,
						to: change.to,
						external: true,
					},
				}),
			);
			handles.session.addMessages(messages).catch((err) => log(`session_start: git observations failed: ${String(err)}`));
		}

		const t1 = Date.now();
		const memoryBlock = await hydrateMemoryContextWithTimeout(handles).catch(() => {
			log(`session_start: hydrate timed out after ${Date.now() - t1}ms`);
			return { userPeerName: "", userRepresentation: "", userPeerCard: null, aiPeerName: "", aiRepresentation: "", aiPeerCard: null, summary: null };
		});
		log(`session_start: hydrate done in ${Date.now() - t1}ms`);
		state.memoryReady = true;

		const t2 = Date.now();
		try {
			const warm = await refreshContextWithTimeout(handles, handles.config.workspace);
			log(`session_start: warmup done in ${Date.now() - t2}ms, got=${!!warm}`);
			if (warm) {
				state.contextCache = { block: warm, queriedAt: Date.now(), messageCount: 0 };
			}
		} catch {
			log(`session_start: warmup failed after ${Date.now() - t2}ms`);
		}

		// Fire-and-forget dialectic queries to warm the knowledge graph (Claude pattern).
		const branchContext = currentGitState ? ` on branch '${currentGitState.branch}'` : "";
		const featureHint = featureContext && featureContext.confidence !== "low"
			? ` Working on: ${featureContext.type} - ${featureContext.description}.`
			: "";
		const dialecticLevel = handles.config.reasoningLevel;
		try {
			if (handles.config.observationMode === "unified") {
				handles.userPeer.chat(
					`Summarize what you know about ${handles.config.peerName}. Focus on preferences, current projects, and working style.${branchContext}${featureHint}`,
					{ session: handles.session, reasoningLevel: dialecticLevel },
				).catch((err) => log(`session_start: dialectic user failed: ${String(err)}`));
				handles.userPeer.chat(
					`What has ${handles.config.peerName} been working on recently?${branchContext}${featureHint} Summarize recent activities relevant to the current work.`,
					{ session: handles.session, reasoningLevel: dialecticLevel },
				).catch((err) => log(`session_start: dialectic recent failed: ${String(err)}`));
			} else {
				handles.aiPeer.chat(
					`Summarize what you know about ${handles.config.peerName}. Focus on preferences, current projects, and working style.${branchContext}${featureHint}`,
					{ target: handles.userPeer, session: handles.session, reasoningLevel: dialecticLevel },
				).catch((err) => log(`session_start: dialectic user failed: ${String(err)}`));
				handles.aiPeer.chat(
					`What has ${handles.config.peerName} been working on recently?${branchContext}${featureHint} Summarize recent activities relevant to the current work.`,
					{ target: handles.userPeer, session: handles.session, reasoningLevel: dialecticLevel },
				).catch((err) => log(`session_start: dialectic recent failed: ${String(err)}`));
			}
		} catch {
			// Non-fatal: dialectic warmup is best-effort.
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		// Drain any queued uploads from the previous session before switching.
		await flushPending().catch(() => {});
		setStatus(ctx, "syncing");
		const handles = await getHandlesFromCtx(ctx);
		if (!handles) {
			setStatus(ctx, undefined);
			return;
		}
		const state = getState(handles.sessionId);
		state.contextCache = { block: null, queriedAt: 0, messageCount: 0 };
		state.lastPromptContextQuery = null;
		state.messageCount = 0;
		// Keep acknowledged message identities across lifecycle refreshes.
		const memoryBlock = await hydrateMemoryContextWithTimeout(handles).catch(() => ({
			userPeerName: "",
			userRepresentation: "",
			userPeerCard: null,
			aiPeerName: "",
			aiRepresentation: "",
			aiPeerCard: null,
			summary: null,
		}));
		state.lastMemoryBlock = memoryBlock;
		state.lastMemoryContext = compileMemoryContext(memoryBlock, null);
		state.memoryReady = true;
		setStatus(ctx, "connected");
	});


	// Clone of Claude's SKIP_CONTEXT_PATTERNS — trivial prompts don't need memory.
	const SKIP_PATTERNS: RegExp[] = [
		/^(y|yes|yeah|ok|okay|k|sure|nope?|no|nah|go|continue|next|thanks|thx|ty|please)\b$/i,
		/^[!?.]+$/,
		/^(what\?|huh\?)\s*$/i,
		/^(\/[\w-]+)$/,
	];
	// Tool hint injected once on first prompt (Claude pattern).
	let sessionToolHint = "";

	/**
	 * Ensure memory has been hydrated before using it.
	 * If session_start hasn't finished yet, hydrate now (blocking).
	 */
	async function ensureMemoryReady(
		state: SessionState,
		handles: HonchoHandles,
	): Promise<MemoryContextBlock> {
		if (state.memoryReady && state.lastMemoryBlock) {
			return state.lastMemoryBlock;
		}
		log(`ensureMemoryReady: memory not ready, hydrating now`);
		const t0 = Date.now();
		const memoryBlock = await hydrateMemoryContextWithTimeout(handles).catch(() => {
			log(`ensureMemoryReady: hydrate timed out after ${Date.now() - t0}ms`);
			return {
				userPeerName: "", userRepresentation: "", userPeerCard: null,
				aiPeerName: "", aiRepresentation: "", aiPeerCard: null,
				summary: null,
			};
		});
		log(`ensureMemoryReady: hydrate done in ${Date.now() - t0}ms`);
		state.lastMemoryBlock = memoryBlock;
		state.lastMemoryContext = compileMemoryContext(memoryBlock, null);
		state.memoryReady = true;
		return memoryBlock;
	}
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		const t0 = Date.now();
		const handles = await getHandlesFromCtx(ctx);
		if (!handles) { log(`before_agent_start: no handles, exiting`); return {}; }

		const state = getState(handles.sessionId);
		state.messageCount += 1;

		// Use event.prompt (the raw user input) for semantic search.
		const query = event.prompt ?? "";
		const hasQuery = query.trim().length > 0 && !SKIP_PATTERNS.some((p) => p.test(query.trim()));
		if (hasQuery) {
			ctx.ui.notify("⌕ 正在检索相关记忆 · Searching relevant memory", "info");
		}

		// S2b: launch ONE bounded raw workspace retrieval per meaningful turn, IN
		// PARALLEL with the prompt-context refresh below (kicked off here, awaited
		// later so the fetch overlaps the context await). Caught at launch: a raw
		// failure must never reject the hook or drop the context path, just as a
		// context failure must never drop raw. A cache hit on the context side
		// still re-runs this raw query. Blank / skip prompts issue no query. Uses
		// raw-search's own internal deadline/abort — no fabricated event.signal.
		const rawResultPromise: Promise<RawSearchResult | null> | null = hasQuery
			? searchWorkspaceMessages(
					{ apiKey: handles.config.apiKey, baseUrl: handles.config.url, workspaceId: handles.config.workspace },
					query,
					{ target: "all" },
				).catch((): null => null)
			: null;

		// Prompt context: cached vs fresh fetch (only when meaningful query available).
		const { ttlSeconds, messageThreshold } = handles.config.contextRefresh;
		let promptContext: PromptContextBlock | null = null;
		// True only when a FRESH refresh failed and we served the stale cache block
		// as a fallback (used to mark the appended region historical; never persisted).
		let contextStale = false;

		if (hasQuery) {
			const cacheIsStale = isCacheStale(state, ttlSeconds, messageThreshold);
			const queryChanged = query !== state.lastPromptContextQuery;

			if (state.contextCache.block && !cacheIsStale && !queryChanged) {
				promptContext = state.contextCache.block;
				log(`before_agent_start: serving prompt context from cache`);
			} else {
				const t1 = Date.now();
				const fresh = await refreshContextWithTimeout(handles, query);
				log(`before_agent_start: refreshContext done in ${Date.now() - t1}ms, got=${!!fresh}`);
				if (fresh) {
					state.contextCache = { block: fresh, queriedAt: Date.now(), messageCount: state.messageCount };
					state.lastPromptContextQuery = query;
					promptContext = fresh;
				} else if (state.contextCache.block) {
					log(`before_agent_start: refresh failed, falling back to stale cache`);
					promptContext = state.contextCache.block;
					contextStale = true;
				}
			}
		}

		// Always compile memory context from session_start cache.
		// Ensure memory is ready before compiling context.
		// session_start may not have finished yet if this fires first.
		const memoryBlock = await ensureMemoryReady(state, handles);

		// Compile memory context. state.lastMemoryContext stays UNMARKED — the
		// stale/refresh-failed marker below is applied to the appended copy only.
		const compiled = compileMemoryContext(memoryBlock, promptContext);
		state.lastMemoryContext = compiled;

		// Append to existing system prompt (do NOT replace it — harness base prompt must stay).
		const systemPrompt = [...event.systemPrompt];

		// Tool hint on first message only (Claude pattern).
		if (state.messageCount === 1) {
			sessionToolHint =
				"Honcho memory tools are available — call honcho_search, honcho_get_context, or honcho_chat to recall " +
				"facts across sessions, and honcho_add_conclusion to save new insights. Prefer querying over guessing.";
		}

		// Context + tool-hint region, bounded to CONTEXT_APPEND_BUDGET (base excluded).
		// On a failed-refresh stale-cache fallback, mark the appended copy historical
		// WITHOUT writing that marker (or raw) into lastMemoryContext / the cache.
		const compiledForAppend = contextStale && compiled ? CONTEXT_STALE_PREFIX + compiled : compiled;
		for (const part of boundContextRegion(compiledForAppend, sessionToolHint)) systemPrompt.push(part);

		// S2b: temporarily append the parallel raw retrieval into its own reserved
		// region. It is surfaced ONLY on the returned prompt for this turn — never
		// written to lastMemoryContext / cache / recentConclusions, never uploaded,
		// never sent as a message. A raw failure degrades to a fixed bounded note
		// and can never make the hook throw.
		let rawAppend: string | null = null;
		if (rawResultPromise) {
			try {
				// The promise never rejects (caught at launch); a null result means a
				// hard failure and buildRawAppend degrades it to the fixed note.
				const rawResult = await rawResultPromise;
				rawAppend = buildRawAppend(rawResult);
			} catch (err) {
				log(`before_agent_start: raw recall unexpected error: ${String(err)}`);
				rawAppend = RAW_UNAVAILABLE_NOTICE;
			}
		}
		if (rawAppend) systemPrompt.push(rawAppend);
		if (hasQuery) {
			ctx.ui.notify("✓ 相关记忆已载入 · Relevant memory loaded", "success");
		}

		log(`before_agent_start: DONE total=${Date.now() - t0}ms, promptLen=${systemPrompt.length}, hasQuery=${hasQuery}, raw=${rawAppend ? "yes" : "no"}`);
		return { systemPrompt };
	});
	pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
		const entryClass = classifyOmpEntry(ctx);
		if (entryClass !== "user_interactive") {
			log(`agent_end: ${entryClass} entry, skipping writes`);
			return;
		}
		const hostSessionId = getNativeSessionId(ctx);
		if (!hostSessionId) return;
		const t0 = Date.now();
		const handles = await getHandlesFromCtx(ctx);
		if (!handles) return;
		setStatus(ctx, "syncing");

		const state = getState(handles.sessionId);
		while (state.agentEndSave) await state.agentEndSave;
		const occurrences = new Map<string, number>();
		const candidates = (event.messages ?? []).flatMap((native) => {
			const pair = collectMessagePairs([native])[0];
			if (!pair) return [];
			const content = pair.role === "user" ? stripInjectedUserText(pair.content) : pair.content;
			if (!content) return [];
			const fingerprint = createHash("sha256").update(JSON.stringify([
				native.id ?? null, native.timestamp ?? null, native.role, content,
			])).digest("hex");
			const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
			occurrences.set(fingerprint, occurrence);
			return [{ ...pair, content, key: `${fingerprint}:${occurrence}` }];
		});
		const pairs = candidates.filter((pair) => !state.savedMessageKeys.has(pair.key));
		if (pairs.length === 0) {
			setStatus(ctx, "connected");
			return;
		}

		log(`agent_end: begin, ${pairs.length} pairs`);
		const newUserTurns = pairs.filter((p) => p.role === "user").length;

		// Build all messages locally (instant, no I/O).
		const batch: HonchoMessage[] = [];
		const userUploadConfig = {
			maxTokens: handles.config.messageUpload.maxUserTokens,
		};
		const assistantUploadConfig = {
			maxTokens: handles.config.messageUpload.maxAssistantTokens,
			summarize: handles.config.messageUpload.summarizeAssistant,
		};
		const metadata = sourceMetadata(entryClass, hostSessionId);

		for (const message of pairs) {
			if (message.role === "user") {
				const content = maybeTruncateContent(message.content, userUploadConfig);
				batch.push(handles.userPeer.message(content, { metadata }));
				const conclusion = extractDurableConclusion(content);
				if (conclusion) {
					// Fire-and-forget: don't block the handler.
					saveUserConclusion(handles, conclusion)
						.then((result) => {
							if (result.saved) {
								state.recentConclusions.unshift(conclusion);
								if (state.recentConclusions.length > 10) state.recentConclusions.length = 10;
							}
						})
						.catch(() => {});
				}
			} else {
				const content = maybeTruncateContent(message.content, assistantUploadConfig);
				batch.push(handles.aiPeer.message(content, { metadata }));
			}
		}

		// Enqueue upload so concurrent agent_end events do not issue parallel
		// addMessages calls. Lifecycle boundaries call flushPending() to drain.
		if (handles.config.saveMessages !== false) {
			ctx.ui.notify("↑ 正在保存本轮记忆 · Saving turn memory", "info");
			const save = queueMessageBatch(handles, batch).then(
				() => {
					for (const pair of pairs) state.savedMessageKeys.add(pair.key);
					state.lastUserTurnCount += newUserTurns;
					log(`agent_end: batch saved in ${Date.now() - t0}ms`);
					setStatus(ctx, "connected");
					ctx.ui.notify("✓ 本轮记忆已保存 · Turn memory saved", "success");
				},
				(err: unknown) => {
					// Retry only when messages reappear in agent_end; no cursor advance.
					// Ambiguous remote success can duplicate on replay (no server idempotency).
					log(`agent_end: batch failed: ${String(err)}`);
					setStatus(ctx, "offline");
				},
			);
			state.agentEndSave = save;
			try { await save; } finally {
				if (state.agentEndSave === save) state.agentEndSave = null;
			}
		} else {
			log(`agent_end: saveMessages disabled, skipping batch upload`);
			setStatus(ctx, "connected");
		}

		log(`agent_end: DONE total=${Date.now() - t0}ms`);
	});
	pi.on("session_before_compact", async (_event, ctx) => {
		// Ensure all pending message uploads complete before compaction runs.
		await flushPending().catch(() => {});
		const handles = await getHandlesFromCtx(ctx);
		if (!handles) return;
		const state = getState(handles.sessionId);
		state.contextCache = { block: null, queriedAt: 0, messageCount: 0 };
		// Keep acknowledged message identities across lifecycle refreshes.

		const memoryBlock = await hydrateMemoryContextWithTimeout(handles).catch(() => ({
			userPeerName: "",
			userRepresentation: "",
			userPeerCard: null,
			aiPeerName: "",
			aiRepresentation: "",
			aiPeerCard: null,
			summary: null,
		}));
		state.lastMemoryBlock = memoryBlock;
		const compiled = compileMemoryContext(memoryBlock, null);
		const continuity = formatContinuityContext(handles, state.lastMemoryContext, state.recentConclusions);

		// Memory anchor — injected before compaction to ensure Honcho conclusions
		// survive summarization (Claude PreCompact pattern).
		const anchor = formatMemoryAnchor(handles.config.peerName, memoryBlock);
		state.lastMemoryContext = [compiled, anchor, continuity].filter(Boolean).join("\n\n") || null;

		// Re-warm prompt context cache before compact.
		try {
			const warm = await refreshContextWithTimeout(handles, handles.config.workspace);
			if (warm) {
				state.contextCache = {
					block: warm,
					queriedAt: Date.now(),
					messageCount: state.messageCount,
				};
			}
		} catch {
			// Re-warm failure is non-fatal.
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const entryClass = classifyOmpEntry(ctx);
		const nativeSessionId = getNativeSessionId(ctx);
		// Drain queued uploads before the session goes away. oh-my-pi caps this
		// handler at 2s, so the flush is awaited but bounded by the host timeout.
		await flushPending().catch(() => {});
		setStatus(ctx, "off");
		const handles = entryClass === "user_interactive" ? await getHandlesFromCtx(ctx).catch(() => null) : null;
		if (handles && nativeSessionId) {
			// Best-effort session-end marker; do not await because oh-my-pi
			// imposes a 2s handler timeout for this event.
			const marker = handles.aiPeer.message(`[Session ended]`, {
				metadata: {
					...sourceMetadata(entryClass, nativeSessionId),
					type: "session_end_marker",
				},
			});
			handles.session
				.addMessages([marker])
				.then(
					() => log(`session_shutdown: end marker uploaded`),
					(err: unknown) => log(`session_shutdown: end marker failed: ${String(err)}`),
				);
		}
		const sessionId = nativeSessionId;
		if (!sessionId) return;
		const sessionKey = deriveSessionKey(ctx.cwd, sessionId);
		sessions.delete(sessionKey);
	});

	registerTools(pi, { getHandles: getHandlesFromCtx });
	registerCommands(pi, { getHandles: getHandlesFromCtx });
}
