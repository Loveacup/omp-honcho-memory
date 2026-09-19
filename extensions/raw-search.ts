/**
 * Slice 1 — raw workspace message retrieval.
 *
 * Bounded semantic evidence retrieval against the official Honcho workspace
 * search endpoint. This is deliberately NOT a corrective index: it cannot claim
 * completeness and does not guarantee that any particular record is returned.
 *
 * Hardening (P1 plan designs 1–4; Codex memory.ts transport reference):
 *  - Dependency-injectable fetch. No SDK, so no implicit get-or-create workspace
 *    or peer/session writes are ever triggered from the query path.
 *  - Strict base-URL allowlist + `redirect: "error"`. Only the official origin
 *    over https with a root or `/v3` path is accepted; userinfo, query, hash, or
 *    any other path is rejected (never normalized). A traversal workspace id
 *    (`.`/`..`) is rejected before any request. Non-official endpoints are
 *    reported `unsupported` and NO request is issued.
 *  - A single `POST /v3/workspaces/{encoded}/search` with body `{query, limit:10}`.
 *    No `filters`, no `peerIds`, no retries. The workspace id is percent-encoded
 *    into one path segment.
 *  - One total deadline (default 3500ms) covering fetch, body, decode, and
 *    result processing. Synchronous JSON.parse cannot be interrupted; an elapsed
 *    deadline is checked afterwards before returning any result; the caller's cancellation signal is chained into the same controller.
 *  - Structured failures that never echo the response body or the auth header.
 *  - Preserves id/content/workspaceId/sessionId/peerId/createdAt from each
 *    record and adds a separate `retrievedAt`. Records missing provenance or
 *    belonging to another workspace are isolated and counted — never fabricated.
 *  - Dedupe by a collision-free (workspace, session, id) tuple. Only a
 *    byte-for-byte duplicate (same content AND peer AND record time) collapses;
 *    same identity with a different body is a `content_conflict`, and same
 *    identity + same body but different peer/time is a `provenance_conflict`.
 *    In every conflict the first record is kept (not overwritten) and the
 *    collision is recorded. Any isolation/conflict marks the result `partial`.
 *  - `target: "user"` performs a bounded LOCAL author filter by userPeerId and
 *    does NOT fall back to "all" when the filtered set is empty.
 */

/** The only endpoint origin this transport is allowed to contact. */
export const OFFICIAL_ORIGIN = "https://api.honcho.dev";

/** Fixed cost bound. Not a recall guarantee. */
export const RAW_SEARCH_LIMIT = 10;

/** Total deadline in ms, including body, decoding, and result processing. */
export const DEFAULT_TIMEOUT_MS = 3500;

/** Verified production API version. */
export const API_VERSION = "v3";

/**
 * The only base URL path shapes accepted for the official origin. We accept the
 * bare root and an explicit `/v3` (with or without a trailing slash) because
 * both are legitimate ways to point at the production API; everything else —
 * userinfo, query, hash, or any other path — is rejected outright rather than
 * normalized away. A base carrying `user:pass@`, `?token=…`, `#frag`, or a
 * rogue path is treated as an unsupported endpoint and no request is issued.
 */
const ALLOWED_BASE_PATHS = new Set<string>(["/", "/v3", "/v3/"]);

/**
 * True only for a base string that resolves to the official origin over https,
 * carries no userinfo/query/hash, and whose path is the root or `/v3`. This is a
 * strict allowlist: we never strip suspicious components and proceed.
 */
function isAllowedBaseUrl(baseUrl: string): boolean {
	let u: URL;
	try {
		u = new URL(baseUrl);
	} catch {
		return false;
	}
	if (u.protocol !== "https:") return false;
	if (u.username !== "" || u.password !== "") return false; // reject userinfo
	if (u.search !== "" || u.hash !== "") return false; // reject query/hash
	if (u.origin !== OFFICIAL_ORIGIN) return false; // host+port must be official
	return ALLOWED_BASE_PATHS.has(u.pathname); // root or /v3 only
}

/**
 * True for a workspace id that would escape its path segment. `encodeURIComponent`
 * leaves bare `.`/`..` untouched, so `..` would collapse `/v3/workspaces/../search`
 * down to `/v3/search` when resolved as a URL. Reject these before any request.
 */
function isTraversalWorkspaceId(workspaceId: string): boolean {
	return workspaceId === "." || workspaceId === "..";
}

export type RawSearchTargetScope = "user" | "all";

export type RawSearchStatus =
	| "ok" // at least one bounded result after processing
	| "empty" // request succeeded but no usable record survived
	| "error" // param/transport/decoding failure
	| "timeout" // exceeded the abort budget
	| "cancelled" // caller signal aborted the request
	| "unsupported"; // non-official endpoint; no request made

export type RawSearchCompleteness = "bounded_semantic";

export interface RawSearchMessage {
	id: string;
	content: string;
	workspaceId: string;
	sessionId: string;
	peerId: string;
	/** Record time from the source; NOT the business effective time. */
	createdAt: string;
	/** Native metadata retained in memory; callers decide what to surface. */
	metadata?: Record<string, unknown>;
}

export type RawSearchConflictReason =
	| "content_conflict" // same (workspace, session, id) but different body text
	| "provenance_conflict"; // same identity + same body but different peer or record time

export interface RawSearchConflict {
	id: string;
	sessionId: string;
	workspaceId: string;
	reason: RawSearchConflictReason;
}

export interface RawSearchResult {
	scope: "workspace";
	query: string;
	/** When this retrieval ran — separate from any record's createdAt. */
	retrievedAt: string;
	status: RawSearchStatus;
	completeness: RawSearchCompleteness;
	target: RawSearchTargetScope;
	messages: RawSearchMessage[];
	/** Count of records isolated (missing provenance, foreign workspace, conflict duplicate). */
	omittedCount: number;
	conflicts: RawSearchConflict[];
	/** True whenever any record was isolated or conflicted. */
	partial: boolean;
	isError: boolean;
	/** Sanitised failure reason. Never contains the body or the auth header. */
	error?: string;
}

export interface RawSearchTransportConfig {
	apiKey: string;
	baseUrl: string;
	workspaceId: string;
}

export interface SearchWorkspaceOptions {
	target?: RawSearchTargetScope;
	/** Required when target === "user"; used only for local author filtering. */
	userPeerId?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Injected for tests; defaults to the global fetch resolved at call time. */
	fetchImpl?: typeof fetch;
	/** Injected clock for deterministic retrievedAt in tests. */
	now?: () => Date;
}

/** Minimal structural view of a fetch Response (keeps the injected impl simple). */
interface FetchResponseLike {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Map one raw API record to a fully-provenanced RawSearchMessage, or null if it
 * is missing any required source field or does not belong to `expectedWorkspaceId`.
 * Nothing is fabricated; a partial record is isolated, not repaired.
 */
function normalizeRecord(raw: unknown, expectedWorkspaceId: string): RawSearchMessage | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;

	const id = nonEmptyString(r.id);
	const content = nonEmptyString(r.content);
	const workspaceId = nonEmptyString(r.workspace_id);
	const sessionId = nonEmptyString(r.session_id);
	const peerId = nonEmptyString(r.peer_id);
	const createdAt = nonEmptyString(r.created_at);

	if (id === null || content === null || workspaceId === null || sessionId === null || peerId === null || createdAt === null) {
		return null;
	}
	// Mixed-workspace guard: a record from another workspace is not evidence for
	// the requested one. Isolate it rather than trusting the response blindly.
	if (workspaceId !== expectedWorkspaceId) return null;

	const message: RawSearchMessage = { id, content, workspaceId, sessionId, peerId, createdAt };
	if (r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)) {
		message.metadata = r.metadata as Record<string, unknown>;
	}
	return message;
}

/**
 * Perform one bounded raw workspace search. Never throws for handled failure
 * modes; always resolves a structured RawSearchResult.
 */
export async function searchWorkspaceMessages(
	config: RawSearchTransportConfig,
	query: string,
	options: SearchWorkspaceOptions = {},
): Promise<RawSearchResult> {
	const target: RawSearchTargetScope = options.target ?? "all";
	const nowFn = options.now ?? (() => new Date());
	const retrievedAt = nowFn().toISOString();

	const make = (
		status: RawSearchStatus,
		extra: Partial<RawSearchResult> = {},
	): RawSearchResult => ({
		scope: "workspace",
		query,
		retrievedAt,
		status,
		completeness: "bounded_semantic",
		target,
		messages: [],
		omittedCount: 0,
		conflicts: [],
		partial: false,
		isError: status === "error" || status === "timeout" || status === "cancelled" || status === "unsupported",
		...extra,
	});

	// ---- parameter validation (no request on bad input) ----
	if (typeof query !== "string" || query.trim().length === 0) {
		return make("error", { error: "raw search requires a non-empty query" });
	}
	if (!nonEmptyString(config.apiKey)) {
		return make("error", { error: "raw search is not configured (missing credentials)" });
	}
	if (!nonEmptyString(config.workspaceId)) {
		return make("error", { error: "raw search is not configured (missing workspace)" });
	}
	if (isTraversalWorkspaceId(config.workspaceId)) {
		return make("error", { error: "raw search workspace id is invalid" });
	}
	if (!nonEmptyString(config.baseUrl)) {
		return make("error", { error: "raw search is not configured (missing endpoint)" });
	}
	if (target === "user" && !nonEmptyString(options.userPeerId)) {
		return make("error", { error: "target=user requires a configured developer peer id" });
	}

	// ---- strict base allowlist (reject, never normalize) ----
	// Validate the configured base string itself before building anything: only
	// the official origin over https with a root or /v3 path is accepted. This
	// closes the origin-only hole where a base like https://user:pass@api.honcho.dev
	// or https://api.honcho.dev?token=… or https://api.honcho.dev/rogue shares the
	// official origin yet smuggles credentials / redirects the path.
	if (!isAllowedBaseUrl(config.baseUrl)) {
		return make("unsupported", {
			error: "endpoint is not the official Honcho base URL; refusing to send",
		});
	}

	// ---- endpoint construction ----
	const expectedPath = `/${API_VERSION}/workspaces/${encodeURIComponent(config.workspaceId)}/search`;
	let requestUrl: URL;
	try {
		requestUrl = new URL(expectedPath, config.baseUrl);
	} catch {
		return make("unsupported", { error: "endpoint base URL is invalid" });
	}
	// Defense in depth: the resolved origin must still be official and the path
	// must be exactly what we intended. If URL normalization collapsed a segment
	// (e.g. a traversal id that slipped past the guard), refuse rather than send.
	if (requestUrl.origin !== OFFICIAL_ORIGIN || requestUrl.pathname !== expectedPath) {
		return make("unsupported", {
			error: "resolved endpoint path is not the official workspace search path; refusing to send",
		});
	}

	// ---- one monotonic deadline, including decode and final result ----
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const deadline = performance.now() + timeoutMs;
	const controller = new AbortController();
	let timedOut = false;
	let cancelled = false;
	let rejectAbort: (reason: Error) => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
	// Also handle pre-aborted callers before the first race is installed.
	void aborted.catch(() => {});
	const stop = (): void => {
		controller.abort();
		rejectAbort(new Error("raw search stopped"));
	};
	const checkDeadline = (): void => {
		if (!cancelled && performance.now() >= deadline) timedOut = true;
		if (timedOut || cancelled) { stop(); throw new Error("raw search stopped"); }
	};
	const finish = (status: RawSearchStatus, extra: Partial<RawSearchResult> = {}): RawSearchResult => {
		const result = make(status, extra);
		checkDeadline();
		return result;
	};

	const external = options.signal;
	const onExternalAbort = (): void => {
		cancelled = true;
		stop();
	};
	if (external) {
		if (external.aborted) {
			cancelled = true;
			stop();
		} else {
			external.addEventListener("abort", onExternalAbort, { once: true });
		}
	}
	const timer = setTimeout(() => {
		timedOut = true;
		stop();
	}, timeoutMs);

	const doFetch: typeof fetch = options.fetchImpl ?? globalThis.fetch;

	let bodyText: string;
	try {
		checkDeadline();
		const response = (await Promise.race([doFetch(requestUrl.toString(), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({ query, limit: RAW_SEARCH_LIMIT }),
			redirect: "error",
			signal: controller.signal,
		}), aborted])) as FetchResponseLike;
		checkDeadline();

		if (!response.ok) {
			// Report only the status code; never the response body or headers.
			return finish("error", { error: `workspace search returned HTTP ${response.status}` });
		}
		// Body read is deliberately inside the same budget/signal.
		bodyText = await Promise.race([response.text(), aborted]);
		checkDeadline();

		// ---- decode ----
		let parsed: unknown;
		try {
			// Synchronous parse cannot be preempted by a timer. Check elapsed time
			// immediately afterwards (including on parse failure) and never return ok late.
			parsed = JSON.parse(bodyText);
			checkDeadline();
		} catch {
			return finish("error", { error: "workspace search returned invalid JSON" });
		}
		if (!Array.isArray(parsed)) {
			return finish("error", { error: "workspace search response was not an array" });
		}

		// ---- provenance validation, dedupe, conflict detection ----
		const kept = new Map<string, RawSearchMessage>();
		const conflicts: RawSearchConflict[] = [];
		let omittedCount = 0;

		for (const raw of parsed) {
			checkDeadline();
			const record = normalizeRecord(raw, config.workspaceId);
			if (!record) {
				omittedCount++;
				continue;
			}
			// Collision-free identity key. A space-joined string conflates
			// (session "a b", id "c") with (session "a", id "b c"); JSON-encoding the
			// tuple keeps each component's boundary unambiguous.
			const key = JSON.stringify([record.workspaceId, record.sessionId, record.id]);
			const existing = kept.get(key);
			if (!existing) {
				kept.set(key, record);
				continue;
			}
			// Same identity. Only a byte-for-byte duplicate (same body AND same peer
			// AND same record time) may collapse silently. Any other divergence is a
			// conflict: keep the first, never overwrite, and mark the result partial.
			if (
				existing.content === record.content &&
				existing.peerId === record.peerId &&
				existing.createdAt === record.createdAt
			) {
				continue;
			}
			const reason: RawSearchConflictReason =
				existing.content !== record.content ? "content_conflict" : "provenance_conflict";
			// Record at most one conflict per identity, but prefer the stronger
			// content_conflict signal if a later record upgrades a provenance_conflict.
			const priorIdx = conflicts.findIndex(
				(c) => c.id === record.id && c.sessionId === record.sessionId && c.workspaceId === record.workspaceId,
			);
			if (priorIdx === -1) {
				conflicts.push({
					id: record.id,
					sessionId: record.sessionId,
					workspaceId: record.workspaceId,
					reason,
				});
			} else if (reason === "content_conflict" && conflicts[priorIdx].reason === "provenance_conflict") {
				conflicts[priorIdx].reason = "content_conflict";
			}
			omittedCount++;
		}

		let messages = [...kept.values()];

		// ---- bounded local author filtering (target=user); NO fallback to all ----
		if (target === "user") {
			messages = messages.filter((m) => m.peerId === options.userPeerId);
		}

		const partial = omittedCount > 0 || conflicts.length > 0;
		const status: RawSearchStatus = messages.length > 0 ? "ok" : "empty";

		return finish(status, { messages, omittedCount, conflicts, partial });
	} catch {
		if (!cancelled && performance.now() >= deadline) timedOut = true;
		if (timedOut) return make("timeout", { error: `raw search exceeded ${timeoutMs}ms budget` });
		if (cancelled) return make("cancelled", { error: "raw search was cancelled" });
		return make("error", { error: "raw search transport error" });
	} finally {
		clearTimeout(timer);
		if (external) external.removeEventListener("abort", onExternalAbort);
	}
}
