import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	branchEntries?: readonly NativeBranchEntry[],
): Promise<string[]> {
	const uploads: string[] = [];
	if (_snapshot) expect([..._snapshot].every((key) => store.has(sessionId, key))).toBe(true);
	await captureNativeMessages(sessionId, messages, state, store, async (pairs) => {
		uploads.push(...pairs.map((pair) => pair.content));
		return true;
	}, undefined, undefined, branchEntries);
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
			expect(store.receiptOutcome(sessionId, nativeMessageKey({
				id: "legacy-a",
				role: "user",
				content: "old input",
			}, 1))).toBe("legacy_seed");
			expect(store.receiptOutcome(sessionId, nativeMessageKey({
				id: "new-no-time",
				role: "user",
				content: "new input",
			}, 1))).toBe("remote_confirmed");
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
			expect(store.receiptOutcome(sessionId, nativeMessageKey({
				id: "retryable",
				role: "user",
				content: "retry me",
			}, 1))).toBeNull();
			expect(store.hasReceiptFile(sessionId)).toBe(true);
			expect(store.pending(sessionId, [nativeMessageKey({ id: "retryable", role: "user", content: "retry me" }, 1)])).toEqual([
				nativeMessageKey({ id: "retryable", role: "user", content: "retry me" }, 1),
			]);
			expect(await captureUploads(sessionId, message, captureState(), snapshot, store)).toEqual(["retry me"]);
			expect(store.receiptOutcome(sessionId, nativeMessageKey({
				id: "retryable",
				role: "user",
				content: "retry me",
			}, 1))).toBe("remote_confirmed");
		});
	});

	test("machine envelope is withheld while a following human input and quoted template are uploaded once", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "mixed-orca-envelope";
			const store = new MessageAckStore(directory);
			const messages = [
				nativeUserMessage("machine-dispatch", [
					"You are working inside Orca, a multi-agent IDE. You are a dispatched worker.",
					"Your coordinator's terminal handle is: synthetic-terminal-17",
					"Your task ID is: synthetic-task-17",
					"Assignment: inspect a synthetic fixture.",
				].join("\n")),
				nativeUserMessage("ambiguous-dispatch", [
					"You are working inside Orca, a multi-agent IDE. You are a dispatched worker.",
					"Your coordinator's terminal handle is: synthetic-terminal-18",
					"Discussion about the missing task identity marker.",
				].join("\n")),
				nativeUserMessage("human-after-dispatch", "Please remember that I prefer concise summaries."),
				nativeUserMessage("human-template-quote", "I saw “You are working inside Orca, a multi-agent IDE.” in the template."),
			];
			const ambiguousEventKeys: string[] = [];
			const state = captureState();
			const captured: Array<{ content: string; key: string; identityKind: string }> = [];

			await captureNativeMessages(sessionId, messages, state, store, async (pairs) => {
				captured.push(...pairs.map(({ content, key, identityKind }) => ({ content, key, identityKind })));
				return true;
			}, undefined, (eventKey) => ambiguousEventKeys.push(eventKey));
			expect(ambiguousEventKeys).toHaveLength(1);

			expect(captured.map((pair) => pair.content)).toEqual([
				"Please remember that I prefer concise summaries.",
				"I saw “You are working inside Orca, a multi-agent IDE.” in the template.",
			]);
			expect(captured.every((pair) => pair.identityKind === "native_message_id")).toBe(true);
			expect(captured[0]?.key).not.toBe(captured[1]?.key);
			expect(await captureUploads(sessionId, messages, captureState(), undefined, store)).toEqual([]);
		});
	});

	test("branch event identity seeds and suppresses the matching id-less native message", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "message-id-only";
			const store = new MessageAckStore(directory);
			const snapshots = new NativeHistorySnapshots();
			const oldMessage: NativeCaptureInput = { role: "user", content: "restored id-less input", timestamp: 1_790_413_200_000 };
			const entries: NativeBranchEntry[] = [{
				type: "message",
				id: "branch-entry-id",
				message: oldMessage,
			}];
			const snapshot = snapshots.observe(sessionId, entries, store);
			expect(await captureUploads(sessionId, [oldMessage], captureState(), snapshot, store, entries)).toEqual([]);
			expect(store.receiptOutcome(sessionId, [...snapshot!][0]!)).toBe("legacy_seed");
		});
	});
	test("legacy snapshots retain payload-only compatibility keys when wrapper identity differs", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "wrapper-versus-payload-identity";
			const store = new MessageAckStore(directory);
			const snapshots = new NativeHistorySnapshots();
			const payload: NativeCaptureInput = {
				role: "user",
				content: "payload has no identity timestamp",
			};
			const entries: NativeBranchEntry[] = [{
				type: "message",
				id: "wrapper-event-id",
				timestamp: "wrapper-only-time",
				message: payload,
			}];
			const snapshot = snapshots.observe(sessionId, entries, store);
			const payloadKey = nativeMessageKey({
				id: null,
				role: "user",
				content: "payload has no identity timestamp",
			}, 1);

			expect(snapshot?.has(payloadKey)).toBe(true);
			expect(await captureUploads(sessionId, [payload], captureState(), snapshot, store)).toEqual([]);
		});
	});

	test("branch event ID becomes the primary cloud-correlation key", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "branch-event-upload";
			const store = new MessageAckStore(directory);
			const message: NativeCaptureInput = {
				role: "user",
				content: "same words can be distinct native events",
				timestamp: 1_790_413_200_000,
			};
			const entries: NativeBranchEntry[] = [{
				type: "message",
				id: "native-branch-event-7",
				message,
			}];
			const uploaded: Array<{ key: string; identityKind: string }> = [];

			await captureNativeMessages(sessionId, [message], captureState(), store, async (pairs) => {
				uploaded.push(...pairs.map(({ key, identityKind }) => ({ key, identityKind })));
				return true;
			}, undefined, undefined, entries);

			expect(uploaded).toEqual([{
				key: nativeMessageKey({
					id: "native-branch-event-7",
					timestamp: 1_790_413_200_000,
					role: "user",
					content: "same words can be distinct native events",
				}, 1),
				identityKind: "native_branch_entry_id",
			}]);
			expect(store.receiptOutcome(sessionId, uploaded[0]!.key)).toBe("remote_confirmed");
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

	test("legacy string receipts remain dedup-only after upgrade", async () => {
		await withTempDirectory(async (directory) => {
			const sessionId = "r1-receipt";
			const message = nativeUserMessage("already-uploaded", "existing input", 1_790_413_200_000);
			const oldKey = createHash("sha256")
				.update(JSON.stringify([["already-uploaded", 1_790_413_200_000, "user"], 1]))
				.digest("hex");
			const fileKey = createHash("sha256").update(sessionId).digest("hex");
			writeFileSync(join(directory, `${fileKey}.jsonl`), `${JSON.stringify(oldKey)}\n`, "utf8");
			const store = new MessageAckStore(directory);

			expect(store.receiptOutcome(sessionId, oldKey)).toBe("legacy_unclassified");
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
