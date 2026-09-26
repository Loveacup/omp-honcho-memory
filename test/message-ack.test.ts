import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageAckStore, nativeMessageKey } from "../extensions/message-ack.js";
import { captureNativeMessages, type NativeCaptureState } from "../extensions/message-capture.js";

function nativeUserMessage(id: string, content: string, timestamp: number | undefined) {
	return { id, timestamp, role: "user", content };
}

function captureState(boundary: number): NativeCaptureState {
	return { savedMessageKeys: new Set(), legacySeedBoundary: boundary };
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "honcho-message-acks-"));
	try {
		await run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("agent_end native-message capture", () => {
	test("shutdown and resume replay does not re-upload acknowledged entries; new identical text uploads once", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "native-session-resume";
			const originals = [
				nativeUserMessage("native-a", "same human input", 1_790_413_310_000),
				nativeUserMessage("native-b", "same human input", 1_790_413_311_000),
			];
			const processAStore = new MessageAckStore(directory);
			const processAState = captureState(1_790_413_300_000);
			const processAUploads: string[] = [];
			await captureNativeMessages(sessionId, originals, processAState, processAStore, async (pairs) => {
				processAUploads.push(...pairs.map((pair) => pair.content));
				return true;
			});
			expect(processAUploads).toEqual(["same human input", "same human input"]);

			// OMP session_shutdown clears volatile state; session_start resumes the same native id.
			const processBState = captureState(1_790_413_320_000);
			const processBStore = new MessageAckStore(directory);
			const replayBatch = [...originals, nativeUserMessage("native-new", "same human input", 1_790_413_321_000)];
			const processBUploads: string[] = [];
			await captureNativeMessages(sessionId, replayBatch, processBState, processBStore, async (pairs) => {
				processBUploads.push(...pairs.map((pair) => pair.content));
				return true;
			});
			expect(processBUploads).toEqual(["same human input"]);
			expect(processBStore.pending(sessionId, [nativeMessageKey({ ...replayBatch[2], role: "user" }, 1)])).toEqual([]);
		});
	});

	test("one-time legacy seed skips pre-boundary restored history but uploads a new event", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "legacy-session";
			const store = new MessageAckStore(directory);
			const state = captureState(1_790_413_320_000);
			const restored = [
				nativeUserMessage("legacy-a", "old input", 1_790_413_308_000),
				nativeUserMessage("legacy-b", "old input", 1_790_413_309_000),
				nativeUserMessage("new-c", "new input", 1_790_413_321_000),
			];
			const uploads: string[] = [];
			await captureNativeMessages(sessionId, restored, state, store, async (pairs) => {
				uploads.push(...pairs.map((pair) => pair.content));
				return true;
			});

			expect(uploads).toEqual(["new input"]);
			expect(store.hasReceiptFile(sessionId)).toBe(true);
		});
	});

	test("a session with an existing receipt file is never legacy-seeded", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "partially-acknowledged-session";
			const store = new MessageAckStore(directory);
			store.acknowledge(sessionId, ["an-existing-ack"]);
			const uploads: string[] = [];
			await captureNativeMessages(sessionId, [nativeUserMessage("old-unacked", "retry old input", 1_790_413_308_000)], captureState(1_790_413_320_000), store, async (pairs) => {
				uploads.push(...pairs.map((pair) => pair.content));
				return true;
			});

			expect(uploads).toEqual(["retry old input"]);
		});
	});

	test("unusable legacy timestamps prefer no duplicate over retry", async () => {
		await withTempDirectory(async (directory) => {
			const uploads: string[] = [];
			await captureNativeMessages("missing-timestamp-session", [nativeUserMessage("no-time", "input", undefined)], captureState(1_790_413_320_000), new MessageAckStore(directory), async (pairs) => {
				uploads.push(...pairs.map((pair) => pair.content));
				return true;
			});
			expect(uploads).toEqual([]);
		});
	});

	test("failed upload is not acknowledged and remains retryable", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "retryable-session";
			const store = new MessageAckStore(directory);
			const state = captureState(1_790_413_300_000);
			const message = [nativeUserMessage("retryable", "retry me", 1_790_413_310_000)];
			await expect(captureNativeMessages(sessionId, message, state, store, async () => {
				throw new Error("fake upload failure");
			})).rejects.toThrow("fake upload failure");
			expect(store.hasReceiptFile(sessionId)).toBe(false);
			const retries: string[] = [];
			await captureNativeMessages(sessionId, message, state, store, async (pairs) => {
				retries.push(...pairs.map((pair) => pair.content));
				return true;
			});
			expect(retries).toEqual(["retry me"]);
		});
	});
});
