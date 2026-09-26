import { collectMessagePairs } from "./message-utils.js";
import { stripInjectedUserText } from "../core/source.js";
import { MessageAckStore, nativeMessageKey } from "./message-ack.js";

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
}

function candidatesFromMessages(messages: readonly NativeCaptureInput[]): Candidate[] {
	const occurrences = new Map<string, number>();
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
		const fingerprint = nativeMessageKey(normalized, 0);
		const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
		occurrences.set(fingerprint, occurrence);
		candidates.push({ pair: { ...pair, content, key: nativeMessageKey(normalized, occurrence) } });
	}
	return candidates;
}

export function snapshotNativeHistory(entries: readonly NativeBranchEntry[]): Set<string> {
	const messages: NativeCaptureInput[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		messages.push({
			...entry.message,
			id: typeof entry.id === "string" ? entry.id : entry.message.id,
			timestamp: entry.message.timestamp ?? entry.timestamp,
		});
	}
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
		entries: readonly NativeBranchEntry[],
		acknowledgements: MessageAckStore,
		onSeedFailure?: () => void,
	): ReadonlySet<string> {
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

/** The production agent_end capture path; upload is injected so tests use fakes. */
export async function captureNativeMessages(
	sessionId: string,
	messages: readonly NativeCaptureInput[],
	state: NativeCaptureState,
	legacySnapshot: ReadonlySet<string>,
	acknowledgements: MessageAckStore,
	upload: (pairs: NativeCapturePair[]) => Promise<boolean>,
	onAcknowledgementFailure?: () => void,
): Promise<NativeCapturePair[]> {
	const candidates = candidatesFromMessages(messages);
	if (!acknowledgements.hasReceiptFile(sessionId)) {
		const seededKeys = candidates
			.map((candidate) => candidate.pair.key)
			.filter((key) => legacySnapshot.has(key));
		acknowledgements.seedLegacy(sessionId, seededKeys);
		for (const key of seededKeys) state.savedMessageKeys.add(JSON.stringify([sessionId, key]));
	}

	const candidatePairs = candidates.map((candidate) => candidate.pair);
	const pendingKeys = new Set(acknowledgements.pending(sessionId, candidatePairs.map((pair) => pair.key)));
	const pairs = candidatePairs.filter((pair) =>
		pendingKeys.has(pair.key) && !state.savedMessageKeys.has(JSON.stringify([sessionId, pair.key])),
	);
	if (pairs.length === 0) return pairs;

	const uploaded = await upload(pairs);
	if (!uploaded) return [];
	if (!acknowledgements.acknowledge(sessionId, pairs.map((pair) => pair.key))) onAcknowledgementFailure?.();
	for (const pair of pairs) state.savedMessageKeys.add(JSON.stringify([sessionId, pair.key]));
	return pairs;
}
