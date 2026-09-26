import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageAckStore, nativeMessageKey, nativeMessageKeyR2 } from "../extensions/message-ack.js";
import {
	captureNativeMessages,
	NativeHistorySnapshots,
	type NativeBranchEntry,
	type NativeCaptureInput,
	type NativeCaptureState,
} from "../extensions/message-capture.js";
import { observeNativeHistoryAtLifecycle } from "../extensions/message-capture.js";

function nativeUserMessage(id: string, content: string, timestamp?: number): NativeCaptureInput {
	return { id, timestamp, role: "user", content };
}

function branchMessage(id: string, content: string, timestamp?: number): NativeBranchEntry {
	return {
		type: "message",
		id,
		timestamp: "2026-09-26T09:00:00.000Z",
		message: { id, role: "user", content, ...(timestamp === undefined ? {} : { timestamp }) },
	};
}

function captureState(): NativeCaptureState {
	return { savedMessageKeys: new Set() };
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "honcho-message-acks-"));
	try {
		await run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

async function captureUploads(
	sessionId: string,
	messages: readonly NativeCaptureInput[],
	state: NativeCaptureState,
	_snapshot: ReadonlySet<string> | undefined,
	store: MessageAckStore,
): Promise<string[]> {
	const uploads: string[] = [];
	if (_snapshot) expect([..._snapshot].every((key) => store.has(sessionId, key))).toBe(true);
	await captureNativeMessages(sessionId, messages, state, store, async (pairs) => {
		uploads.push(...pairs.map((pair) => pair.content));
		return true;
	});
	return uploads;
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
			const processASnapshots = new NativeHistorySnapshots();
			const processASnapshot = processASnapshots.observe(sessionId, [], processAStore);
			expect(await captureUploads(sessionId, originals, captureState(), processASnapshot, processAStore)).toEqual([
				"same human input", "same human input",
			]);

			// Shutdown drops volatile snapshots; the same native session resumes with acknowledged receipts.
			processASnapshots.delete(sessionId);
			const processBSnapshots = new NativeHistorySnapshots();
			const processBStore = new MessageAckStore(directory);
			const replayedHistory = originals.map((message) =>
				branchMessage(message.id as string, message.content as string, message.timestamp as number),
			);
			const processBSnapshot = processBSnapshots.observe(sessionId, replayedHistory, processBStore);
			const replayBatch = [...originals, nativeUserMessage("native-new", "same human input", 1_790_413_321_000)];
			expect(await captureUploads(sessionId, replayBatch, captureState(), processBSnapshot, processBStore)).toEqual([
				"same human input",
			]);
		});
	});

	test("legacy snapshot skips only restored identities; a new timestamp-less human message uploads once", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "legacy-session";
			const store = new MessageAckStore(directory);
			const snapshots = new NativeHistorySnapshots();
			const restored = [branchMessage("legacy-a", "old input"), branchMessage("legacy-b", "old input")];
			const snapshot = snapshots.observe(sessionId, restored, store);
			const eventMessages = [
				nativeUserMessage("legacy-a", "old input"),
				nativeUserMessage("legacy-b", "old input"),
				nativeUserMessage("new-no-time", "new input"),
			];

			expect(await captureUploads(sessionId, eventMessages, captureState(), snapshot, store)).toEqual(["new input"]);
		});
	});

	test("clock rollback and seconds-resolution timestamps do not classify unseen messages as legacy", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "clock-change-session";
			const store = new MessageAckStore(directory);
			const snapshots = new NativeHistorySnapshots();
			const snapshot = snapshots.observe(sessionId, [branchMessage("restored", "old history")], store);
			const newMessages = [
				nativeUserMessage("clock-rollback", "after rollback", 1_700_000_000_000),
				nativeUserMessage("seconds-resolution", "same-second new input", 1_790_413_200),
			];

			expect(await captureUploads(sessionId, newMessages, captureState(), snapshot, store)).toEqual([
				"after rollback", "same-second new input",
			]);
		});
	});

	test("a brand-new session takes an empty snapshot and uploads a timestamp-less input", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "brand-new-session";
			const store = new MessageAckStore(directory);
			const snapshots = new NativeHistorySnapshots();
			const snapshot = snapshots.observe(sessionId, [], store);

			expect(snapshot?.size).toBe(0);
			expect(store.hasReceiptFile(sessionId)).toBe(true);
			expect(await captureUploads(sessionId, [nativeUserMessage("first-input", "hello")], captureState(), snapshot, store)).toEqual([
				"hello",
			]);
		});
	});

	test("an existing receipt file prevents legacy seeding", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "partially-acknowledged-session";
			const store = new MessageAckStore(directory);
			store.acknowledge(sessionId, ["some-other-existing-ack"]);
			const snapshots = new NativeHistorySnapshots();
			const snapshot = snapshots.observe(sessionId, [branchMessage("old-unacked", "retry old input")], store);

			expect(await captureUploads(sessionId, [nativeUserMessage("old-unacked", "retry old input")], captureState(), snapshot, store)).toEqual([
				"retry old input",
			]);
		});
	});

	test("native A and legacy B keep independent restored-history snapshots despite a shared Honcho session", async () => {
		await withTempDirectory(async (directory) => {
			const store = new MessageAckStore(directory);
			const snapshots = new NativeHistorySnapshots();
			const snapshotA = snapshots.observe("native-A", [branchMessage("A-old", "A old history")], store);
			const snapshotB = snapshots.observe("native-B", [branchMessage("B-old", "B old history")], store);
			expect([...snapshotA!]).not.toEqual([...snapshotB!]);

			// Both native sessions can resolve to the same Honcho session key; receipts/snapshots remain native-keyed.
			expect(await captureUploads("native-B", [
				nativeUserMessage("B-old", "B old history"),
				nativeUserMessage("B-new", "B new input"),
			], captureState(), snapshotB, store)).toEqual(["B new input"]);
		});
	});

	test("failed upload remains retryable", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "retryable-session";
			const store = new MessageAckStore(directory);
			const snapshots = new NativeHistorySnapshots();
			const snapshot = snapshots.observe(sessionId, [], store);
			const message = [nativeUserMessage("retryable", "retry me")];
			await expect(captureNativeMessages(sessionId, message, captureState(), store, async () => {
				throw new Error("fake upload failure");
			})).rejects.toThrow("fake upload failure");
			expect(store.hasReceiptFile(sessionId)).toBe(true);
			expect(store.pending(sessionId, [nativeMessageKey({ id: "retryable", role: "user", content: "retry me" }, 1)])).toEqual([
				nativeMessageKey({ id: "retryable", role: "user", content: "retry me" }, 1),
			]);
			expect(await captureUploads(sessionId, message, captureState(), snapshot, store)).toEqual(["retry me"]);
		});
	});

	test("branch entry IDs do not replace message identity", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "message-id-only";
			const store = new MessageAckStore(directory);
			const snapshots = new NativeHistorySnapshots();
			const oldMessage: NativeCaptureInput = { role: "user", content: "restored id-less input", timestamp: 1_790_413_200_000 };
			const snapshot = snapshots.observe(sessionId, [{
				type: "message",
				id: "branch-entry-id",
				message: oldMessage,
			}], store);
			expect(await captureUploads(sessionId, [oldMessage], captureState(), snapshot, store)).toEqual([]);
		});
	});

	test("an agent_end first seen with its current branch does not seed the current message", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "late-first-observation";
			const store = new MessageAckStore(directory);
			const current = nativeUserMessage("first-current-turn", "current human input");
			expect(await captureUploads(sessionId, [current], captureState(), undefined, store)).toEqual(["current human input"]);
			expect(store.load(sessionId)).toEqual(new Set([nativeMessageKey({
				id: "first-current-turn",
				role: "user",
				content: "current human input",
			}, 1)]));
		});
	});

	test("an r1 receipt remains acknowledged after upgrade", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "r1-receipt";
			const store = new MessageAckStore(directory);
			const message = nativeUserMessage("already-uploaded", "existing input", 1_790_413_200_000);
			const oldKey = createHash("sha256")
				.update(JSON.stringify([["already-uploaded", 1_790_413_200_000, "user"], 1]))
				.digest("hex");
			store.seedLegacy(sessionId, [oldKey]);
			expect(await captureUploads(sessionId, [message], captureState(), new Set(), store)).toEqual([]);
		});
	});

	test("a failed branch read does not cache an empty observation", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "branch-read-recovery";
			const store = new MessageAckStore(directory);
			const snapshots = new NativeHistorySnapshots();
			expect(observeNativeHistoryAtLifecycle(sessionId, undefined, snapshots, store)).toBeUndefined();
			expect(observeNativeHistoryAtLifecycle(sessionId, () => {
				throw new Error("branch unavailable");
			}, snapshots, store)).toBeUndefined();
			expect(store.hasReceiptFile(sessionId)).toBe(false);
			const recovered = branchMessage("restored-after-read", "restored history");
			const snapshotAfterRecovery = observeNativeHistoryAtLifecycle(sessionId, () => [recovered], snapshots, store);
			expect(await captureUploads(sessionId, [nativeUserMessage("restored-after-read", "restored history")], captureState(), snapshotAfterRecovery, store)).toEqual([]);
		});
	});

	test("r2 receipts remain acknowledged across the r1-key compatibility cutover", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "r2-receipt";
			const store = new MessageAckStore(directory);
			const message = nativeUserMessage("r2-uploaded", "r2 input", 1_790_413_200_000);
			store.acknowledge(sessionId, [nativeMessageKeyR2({
				id: "r2-uploaded",
				timestamp: 1_790_413_200_000,
				role: "user",
				content: "r2 input",
			}, 1)]);
			expect(await captureUploads(sessionId, [message], captureState(), new Set(), store)).toEqual([]);
		});
	});

	test("session_start skips restored legacy history and uploads a later human message", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "observed-legacy-session";
			const store = new MessageAckStore(directory);
			const snapshots = new NativeHistorySnapshots();
			const restored = branchMessage("restored-human", "restored input");
			const snapshot = observeNativeHistoryAtLifecycle(sessionId, () => [restored], snapshots, store);
			expect(await captureUploads(sessionId, [
				nativeUserMessage("restored-human", "restored input"),
				nativeUserMessage("new-human", "new input"),
			], captureState(), snapshot, store)).toEqual(["new input"]);
		});
	});

	test("a brand-new session records an empty legacy snapshot", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "empty-observation";
			const store = new MessageAckStore(directory);
			const snapshots = new NativeHistorySnapshots();
			const snapshot = observeNativeHistoryAtLifecycle(sessionId, () => [], snapshots, store);
			expect(snapshot?.size).toBe(0);
			expect(store.load(sessionId)).toEqual(new Set());
		});
	});
});
