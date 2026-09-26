import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface NativeMessageIdentity {
	id?: string | null;
	timestamp?: string | number | null;
	role: string;
	content: string;
}

/** Stable identity for one native event; repeated text in a new event stays distinct. */
export function nativeMessageKey(message: NativeMessageIdentity, occurrence: number): string {
	const identity = message.id
		? [message.id, message.timestamp ?? null, message.role]
		: [null, message.timestamp ?? null, message.role, message.content];
	return createHash("sha256").update(JSON.stringify([identity, occurrence])).digest("hex");
}

/** Append-only acknowledgements survive OMP session resume and extension reload. */
export class MessageAckStore {
	private readonly directory: string;
	private readonly loaded = new Map<string, Set<string>>();

	constructor(directory = join(homedir(), ".omp", "agent", "honcho-message-acks")) {
		this.directory = directory;
	}

	load(sessionId: string): Set<string> {
		const cached = this.loaded.get(sessionId);
		const keys = new Set(cached);
		try {
			const file = this.sessionFile(sessionId);
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line) continue;
				try {
					const value: unknown = JSON.parse(line);
					if (typeof value === "string") keys.add(value);
				} catch {
					// Ignore an incomplete final append; a failed write is not acknowledged.
				}
			}
		} catch {
			// Missing/unreadable storage fails open so capture can continue.
		}
		this.loaded.set(sessionId, keys);
		return new Set(keys);
	}
	pending(sessionId: string, keys: readonly string[]): string[] {
		const acknowledged = this.load(sessionId);
		return keys.filter((key) => !acknowledged.has(key));
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
			appendFileSync(this.sessionFile(sessionId), additions.map((key) => `${JSON.stringify(key)}\n`).join(""), { encoding: "utf8" });
			for (const key of additions) known.add(key);
			this.loaded.set(sessionId, known);
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
