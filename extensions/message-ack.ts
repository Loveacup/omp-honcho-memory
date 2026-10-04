import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface NativeMessageIdentity {
	id?: string | null;
	timestamp?: string | number | null;
	role: string;
	content: string;
}

type ReceiptOutcome = "legacy_seed" | "legacy_unclassified" | "remote_confirmed";

interface ReceiptRecord {
	key: string;
	outcome: ReceiptOutcome;
}
/** Deployed r1 durable identity; new receipts must continue using this format. */
export function nativeMessageKey(message: NativeMessageIdentity, occurrence: number): string {
	const identity = message.id
		? [message.id, message.timestamp ?? null, message.role]
		: [null, message.timestamp ?? null, message.role, message.content];
	return createHash("sha256").update(JSON.stringify([identity, occurrence])).digest("hex");
}

/** r2 compatibility identity, read-only after the r1 key-format restoration. */
export function nativeMessageKeyR2(message: NativeMessageIdentity, occurrence: number): string {
	const identity = message.id
		? [message.id, message.role]
		: [null, message.timestamp ?? null, message.role, message.content];
	return createHash("sha256").update(JSON.stringify([identity, occurrence])).digest("hex");
}

/** Append-only receipts preserve dedup; only remote_confirmed proves observed upload success. */
export class MessageAckStore {
	private readonly directory: string;
	private readonly loaded = new Map<string, Set<string>>();
	private readonly outcomes = new Map<string, Map<string, ReceiptOutcome>>();

	constructor(directory = join(homedir(), ".omp", "agent", "honcho-message-acks")) {
		this.directory = directory;
	}

	load(sessionId: string): Set<string> {
		const keys = new Set(this.loaded.get(sessionId));
		const outcomes = this.outcomes.get(sessionId) ?? new Map<string, ReceiptOutcome>();
		try {
			const file = this.sessionFile(sessionId);
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line) continue;
				try {
					const value: unknown = JSON.parse(line);
					if (typeof value === "string") {
						keys.add(value);
						if (!outcomes.has(value)) outcomes.set(value, "legacy_unclassified");
					} else if (value !== null && typeof value === "object") {
						const record = value as Partial<ReceiptRecord>;
						if (typeof record.key === "string"
							&& (record.outcome === "legacy_seed" || record.outcome === "legacy_unclassified" || record.outcome === "remote_confirmed")) {
							keys.add(record.key);
							const previous = outcomes.get(record.key);
							if (record.outcome === "remote_confirmed" || previous === undefined) outcomes.set(record.key, record.outcome);
						}
					}
				} catch {
					// Ignore an incomplete final append; a failed write is not acknowledged.
				}
			}
		} catch {
			// Missing/unreadable storage fails open so capture can continue.
		}
		this.loaded.set(sessionId, keys);
		this.outcomes.set(sessionId, outcomes);
		return new Set(keys);
	}

	receiptOutcome(sessionId: string, key: string): ReceiptOutcome | null {
		this.load(sessionId);
		return this.outcomes.get(sessionId)?.get(key) ?? null;
	}
	pending(sessionId: string, keys: readonly string[]): string[] {
		const acknowledged = this.load(sessionId);
		return keys.filter((key) => !acknowledged.has(key));
	}
	hasReceiptFile(sessionId: string): boolean {
		return existsSync(this.sessionFile(sessionId));
	}

	/** Initialize a native-session migration seed once; seeds remain dedup-only, never remote success. */
	seedLegacy(sessionId: string, keys: readonly string[]): boolean {
		if (this.hasReceiptFile(sessionId)) return false;
		try {
			mkdirSync(this.directory, { recursive: true });
			const rows = keys.map((key) => `${JSON.stringify({ key, outcome: "legacy_seed" })}\n`).join("");
			writeFileSync(this.sessionFile(sessionId), rows, { encoding: "utf8", flag: "wx" });
			const known = this.loaded.get(sessionId) ?? new Set<string>();
			const outcomes = this.outcomes.get(sessionId) ?? new Map<string, ReceiptOutcome>();
			for (const key of keys) {
				known.add(key);
				outcomes.set(key, "legacy_seed");
			}
			this.loaded.set(sessionId, known);
			this.outcomes.set(sessionId, outcomes);
			return true;
		} catch {
			return false;
		}
	}

	has(sessionId: string, key: string): boolean {
		return this.load(sessionId).has(key);
	}

	/** Call only after the remote message batch has been acknowledged. */
	acknowledge(sessionId: string, keys: readonly string[]): boolean {
		const known = this.loaded.get(sessionId) ?? this.load(sessionId);
		const additions = [...new Set(keys)].filter((key) => !known.has(key));
		if (additions.length === 0) return true;
		try {
			mkdirSync(this.directory, { recursive: true });
			const rows = additions.map((key) => `${JSON.stringify({ key, outcome: "remote_confirmed" })}\n`).join("");
			appendFileSync(this.sessionFile(sessionId), rows, { encoding: "utf8" });
			const outcomes = this.outcomes.get(sessionId) ?? new Map<string, ReceiptOutcome>();
			for (const key of additions) {
				known.add(key);
				outcomes.set(key, "remote_confirmed");
			}
			this.loaded.set(sessionId, known);
			this.outcomes.set(sessionId, outcomes);
			return true;
		} catch {
			return false;
		}
	}

	private sessionFile(sessionId: string): string {
		const fileKey = createHash("sha256").update(sessionId).digest("hex");
		return join(this.directory, `${fileKey}.jsonl`);
	}
}
