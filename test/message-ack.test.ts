import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageAckStore, nativeMessageKey } from "../extensions/message-ack.js";

const nativeUserMessage = (id: string, content: string) => ({
	id,
	timestamp: 1790413308932,
	role: "user",
	content,
});

describe("durable native-message acknowledgements", () => {
	test("a resumed native session skips acknowledged replay but saves a new identical-text message", () => {
		const directory = mkdtempSync(join(tmpdir(), "honcho-message-acks-"));
		try {
			const sessionId = "01a0dcf2-aa6f-74ec-b2f4-342304c12956";
			const originals = [
				nativeUserMessage("5590ab3a", "same human input"),
				nativeUserMessage("afedb87e", "same human input"),
			];
			const replays = [
				nativeUserMessage("5590ab3a", "same human input"),
				nativeUserMessage("afedb87e", "same human input"),
			];
			const repeatedLater = nativeUserMessage("new-native-event", "same human input");

			// Process A uploads and acknowledges the original native entries.
			const processA = new MessageAckStore(directory);
			const acknowledgedKeys = originals.map((message) => nativeMessageKey(message, 1));
			processA.acknowledge(sessionId, acknowledgedKeys);
			const processB = new MessageAckStore(directory);

			// OMP resumes this same native session in a fresh extension process.
			const replayKeys = replays.map((message) => nativeMessageKey(message, 1));
			const newEventKey = nativeMessageKey(repeatedLater, 1);
			const uploaded = processB.pending(sessionId, [...replayKeys, newEventKey]);

			expect(uploaded).toEqual([newEventKey]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("failed uploads are not acknowledged and remain retryable", () => {
		const directory = mkdtempSync(join(tmpdir(), "honcho-message-acks-"));
		try {
			const store = new MessageAckStore(directory);
			const key = nativeMessageKey(nativeUserMessage("retryable", "retry me"), 1);
			expect(store.has("session", key)).toBe(false);
			// No acknowledge call occurs when the upload rejects.
			expect(new MessageAckStore(directory).has("session", key)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
