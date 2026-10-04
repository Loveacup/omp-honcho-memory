import { collectMessagePairs } from "./message-utils.js";
import { classifyOrcaEnvelope, stripOmpUserText } from "../core/source.js";
import { MessageAckStore, nativeMessageKey, nativeMessageKeyR2 } from "./message-ack.js";

export interface NativeCaptureInput {
	id?: unknown;
	nativeEventId?: unknown;
	timestamp?: unknown;
	role: string;
	content?: unknown;
}

export interface NativeCapturePair {
	role: "user" | "assistant";
	content: string;
	key: string;
	identityKind: "native_branch_entry_id" | "native_message_id" | "timestamp_content_fallback";
}

export interface NativeCaptureState {
	savedMessageKeys: Set<string>;
}

export interface NativeBranchEntry {
	type: string;
	id?: unknown;
	timestamp?: unknown;
	message?: NativeCaptureInput;
}

interface Candidate {
	pair: NativeCapturePair;
	receiptKeys: readonly string[];
}
function branchEventIdMap(entries: readonly NativeBranchEntry[]): Map<string, string | null> {
	const idsByFingerprint = new Map<string, string | null>();
	for (const entry of entries) {
		if (entry.type !== "message" || typeof entry.id !== "string" || !entry.message) continue;
		const pair = collectMessagePairs([entry.message])[0];
		if (!pair) continue;
		const timestamp = typeof entry.message.timestamp === "string" || typeof entry.message.timestamp === "number"
			? entry.message.timestamp
			: null;
		const fingerprint = nativeMessageKey({ id: null, timestamp, role: pair.role, content: pair.content }, 1);
		idsByFingerprint.set(fingerprint, idsByFingerprint.has(fingerprint) ? null : entry.id);
	}
	return idsByFingerprint;
}

function candidatesFromMessages(
	messages: readonly NativeCaptureInput[],
	onAmbiguousSource?: (eventKey: string) => void,
	branchEntries?: readonly NativeBranchEntry[],
): Candidate[] {
	// Preserve deployed r1/r2 identities as compatibility receipts while using a
	// matched native branch-entry ID as the current event identity when available.
	const primaryOccurrences = new Map<string, number>();
	const r1Occurrences = new Map<string, number>();
	const r2Occurrences = new Map<string, number>();
	const branchIds = branchEntries ? branchEventIdMap(branchEntries) : undefined;
	const candidates: Candidate[] = [];
	for (const native of messages) {
		const pair = collectMessagePairs([native])[0];
		if (!pair) continue;
		const rawContent = pair.content;
		const timestamp = typeof native.timestamp === "string" || typeof native.timestamp === "number" ? native.timestamp : null;
		const legacyIdentity = {
			id: typeof native.id === "string" ? native.id : null,
			timestamp,
			role: pair.role,
			content: rawContent,
		};
		const matchFingerprint = nativeMessageKey({ ...legacyIdentity, id: null }, 1);
		const branchId = typeof native.nativeEventId === "string"
			? native.nativeEventId
			: branchIds?.get(matchFingerprint) ?? null;
		const nativeEventId = branchId ?? legacyIdentity.id;
		if (pair.role === "user" && classifyOrcaEnvelope(rawContent) === "ambiguous") {
			onAmbiguousSource?.(nativeMessageKey({ ...legacyIdentity, id: nativeEventId }, 1));
		}
		const content = pair.role === "user" ? stripOmpUserText(rawContent) : rawContent;
		if (!content) continue;

		const legacyNormalized = { ...legacyIdentity, content };
		const r1Fingerprint = nativeMessageKey(legacyNormalized, 0);
		const r1Occurrence = (r1Occurrences.get(r1Fingerprint) ?? 0) + 1;
		r1Occurrences.set(r1Fingerprint, r1Occurrence);
		const r2Fingerprint = nativeMessageKeyR2(legacyNormalized, 0);
		const r2Occurrence = (r2Occurrences.get(r2Fingerprint) ?? 0) + 1;
		r2Occurrences.set(r2Fingerprint, r2Occurrence);

		const normalized = { ...legacyNormalized, id: nativeEventId };
		const primaryFingerprint = nativeMessageKey(normalized, 0);
		const primaryOccurrence = (primaryOccurrences.get(primaryFingerprint) ?? 0) + 1;
		primaryOccurrences.set(primaryFingerprint, primaryOccurrence);
		const key = nativeMessageKey(normalized, primaryOccurrence);
		candidates.push({
			pair: {
				...pair,
				content,
				key,
				identityKind: branchId
					? "native_branch_entry_id"
					: legacyIdentity.id ? "native_message_id" : "timestamp_content_fallback",
			},
			receiptKeys: [key, nativeMessageKey(legacyNormalized, r1Occurrence), nativeMessageKeyR2(legacyNormalized, r2Occurrence)],
		});
	}
	return candidates;
}

/** Build migration identities and compatibility receipts from native branch entries. */
export function snapshotNativeHistory(entries: readonly NativeBranchEntry[]): Set<string> {
	const messages = entries
		.filter((entry) => entry.type === "message" && entry.message)
		.map((entry) => ({
			...entry.message!,
			nativeEventId: typeof entry.id === "string" ? entry.id : entry.message!.nativeEventId,
		}));
	const keys = new Set<string>();
	for (const candidate of candidatesFromMessages(messages)) {
		keys.add(candidate.pair.key);
		for (const receiptKey of candidate.receiptKeys) keys.add(receiptKey);
	}
	return keys;
}

/**
 * Migration snapshots are isolated by OMP native session, not shared Honcho session.
 * Pre-upgrade history already present at first observation is treated as acknowledged,
 * so any upload that failed before this migration is intentionally not retried.
 */
export class NativeHistorySnapshots {
	private readonly snapshots = new Map<string, Set<string>>();

	observe(
		sessionId: string,
		entries: readonly NativeBranchEntry[] | null | undefined,
		acknowledgements: MessageAckStore,
		onSeedFailure?: () => void,
	): ReadonlySet<string> | undefined {
		if (!entries) return undefined;
		if (!this.snapshots.has(sessionId)) {
			const hasReceiptFile = acknowledgements.hasReceiptFile(sessionId);
			const snapshot = hasReceiptFile ? new Set<string>() : snapshotNativeHistory(entries);
			this.snapshots.set(sessionId, snapshot);
			if (!hasReceiptFile && !acknowledgements.seedLegacy(sessionId, [...snapshot])) onSeedFailure?.();
		}
		return this.snapshots.get(sessionId)!;
	}

	delete(sessionId: string): void {
		this.snapshots.delete(sessionId);
	}
}

/** Observe only when a lifecycle caller can successfully read the native branch. */
export function observeNativeHistoryAtLifecycle(
	sessionId: string,
	getBranch: (() => readonly NativeBranchEntry[]) | undefined,
	snapshots: NativeHistorySnapshots,
	acknowledgements: MessageAckStore,
	onReadFailure?: (error: unknown) => void,
	onSeedFailure?: () => void,
): ReadonlySet<string> | undefined {
	if (!getBranch) return undefined;
	let entries: readonly NativeBranchEntry[];
	try {
		entries = getBranch();
	} catch (error) {
		onReadFailure?.(error);
		return undefined;
	}
	return snapshots.observe(sessionId, entries, acknowledgements, onSeedFailure);
}

/** The production agent_end capture path; upload is injected so tests use fakes. */
export async function captureNativeMessages(
	sessionId: string,
	messages: readonly NativeCaptureInput[],
	state: NativeCaptureState,
	acknowledgements: MessageAckStore,
	upload: (pairs: NativeCapturePair[]) => Promise<boolean>,
	onAcknowledgementFailure?: () => void,
	onAmbiguousSource?: (eventKey: string) => void,
	branchEntries?: readonly NativeBranchEntry[],
): Promise<NativeCapturePair[]> {
	const candidates = candidatesFromMessages(messages, onAmbiguousSource, branchEntries);
	const acknowledged = acknowledgements.load(sessionId);
	const pairs = candidates
		.filter((candidate) =>
			!candidate.receiptKeys.some((key) =>
				acknowledged.has(key) || state.savedMessageKeys.has(JSON.stringify([sessionId, key])),
			),
		)
		.map((candidate) => candidate.pair);
	if (pairs.length === 0) return pairs;

	const uploaded = await upload(pairs);
	if (!uploaded) return [];
	if (!acknowledgements.acknowledge(sessionId, pairs.map((pair) => pair.key))) onAcknowledgementFailure?.();
	for (const pair of pairs) state.savedMessageKeys.add(JSON.stringify([sessionId, pair.key]));
	return pairs;
}
