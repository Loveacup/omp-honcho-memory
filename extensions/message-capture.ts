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
	legacySeedBoundary: number;
}

function timestampMillis(timestamp: unknown): number | null {
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return Math.abs(timestamp) < 100_000_000_000 ? timestamp * 1000 : timestamp;
	if (typeof timestamp !== "string" || !timestamp.trim()) return null;
	const numeric = Number(timestamp);
	if (Number.isFinite(numeric)) return Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : null;
}

function isLegacyMessage(timestamp: unknown, boundary: number): boolean {
	const messageTime = timestampMillis(timestamp);
	// One-time migration favors avoiding duplicates: pre-upgrade history older than
	// this process boundary is seeded as acknowledged, even if an earlier upload
	// failed. Missing/invalid timestamps take the same no-duplicate path.
	return messageTime === null || messageTime < boundary;
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
	const occurrences = new Map<string, number>();
	const candidates: { pair: NativeCapturePair; timestamp: unknown }[] = [];
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
		candidates.push({
			pair: { ...pair, content, key: nativeMessageKey(normalized, occurrence) },
			timestamp: native.timestamp,
		});
	}

	if (!acknowledgements.hasReceiptFile(sessionId)) {
		const legacy = candidates.filter((candidate) =>
			isLegacyMessage(candidate.timestamp, state.legacySeedBoundary),
		);
		const seededKeys = legacy.map((candidate) => candidate.pair.key);
		acknowledgements.seedLegacy(sessionId, seededKeys);
		for (const key of seededKeys) state.savedMessageKeys.add(key);
	}

	const candidatePairs = candidates.map((candidate) => candidate.pair);
	const pendingKeys = new Set(acknowledgements.pending(sessionId, candidatePairs.map((pair) => pair.key)));
	const pairs = candidatePairs.filter((pair) => pendingKeys.has(pair.key) && !state.savedMessageKeys.has(pair.key));
	if (pairs.length === 0) return pairs;

	const uploaded = await upload(pairs);
	if (!uploaded) return [];
	if (!acknowledgements.acknowledge(sessionId, pairs.map((pair) => pair.key))) onAcknowledgementFailure?.();
	for (const pair of pairs) state.savedMessageKeys.add(pair.key);
	return pairs;
}
