import { collectMessagePairs } from "./message-utils.js";
import { stripInjectedUserText } from "../core/source.js";
import { MessageAckStore, nativeMessageKey, nativeMessageKeyR2 } from "./message-ack.js";

export interface NativeCaptureInput {
	id?: unknown;
	timestamp?: unknown;
	role: string;
	content?: unknown;
}

export interface NativeCapturePair {
	role: "user" | "assistant";
	content: string;
	key: string;
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
function candidatesFromMessages(messages: readonly NativeCaptureInput[]): Candidate[] {

	// Count duplicates in each ordered full-history input; snapshots and agent_end both see
	// session history. Native millisecond timestamps keep same-ID r1 occurrence groups stable.
	const r1Occurrences = new Map<string, number>();
	const r2Occurrences = new Map<string, number>();
	const candidates: Candidate[] = [];
	for (const native of messages) {
		const pair = collectMessagePairs([native])[0];
		if (!pair) continue;
		const content = pair.role === "user" ? stripInjectedUserText(pair.content) : pair.content;
		if (!content) continue;
		const normalized = {
			id: typeof native.id === "string" ? native.id : null,
			timestamp: typeof native.timestamp === "string" || typeof native.timestamp === "number" ? native.timestamp : null,
			role: pair.role,
			content,
		};
		const r1Fingerprint = nativeMessageKey(normalized, 0);
		const r1Occurrence = (r1Occurrences.get(r1Fingerprint) ?? 0) + 1;
		r1Occurrences.set(r1Fingerprint, r1Occurrence);
		const r2Fingerprint = nativeMessageKeyR2(normalized, 0);
		const r2Occurrence = (r2Occurrences.get(r2Fingerprint) ?? 0) + 1;
		r2Occurrences.set(r2Fingerprint, r2Occurrence);
		const key = nativeMessageKey(normalized, r1Occurrence);
		candidates.push({
			pair: { ...pair, content, key },
			receiptKeys: [key, nativeMessageKeyR2(normalized, r2Occurrence)],
		});
	}
	return candidates;
}

/** Build migration identities from message payloads only, matching agent_end normalization. */
export function snapshotNativeHistory(entries: readonly NativeBranchEntry[]): Set<string> {
	const messages = entries
		.filter((entry) => entry.type === "message" && entry.message)
		.map((entry) => entry.message!);
	return new Set(candidatesFromMessages(messages).map((candidate) => candidate.pair.key));
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
): Promise<NativeCapturePair[]> {
	const candidates = candidatesFromMessages(messages);
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
