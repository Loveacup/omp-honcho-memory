import { closeSync, fchmodSync, lstatSync, openSync, realpathSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { Honcho } from "@honcho-ai/sdk";

const ROOT_ENV = "HONCHO_ISOLATED_RUN_DIR";
const TOOLS_ENV = "HONCHO_ISOLATED_ACTIVE_TOOLS";
const LOG_NAME = "honcho-plugin.jsonl";
const LOG_CATEGORIES: Record<string, true> = {
	agent_end: true,
	before_agent_start: true,
	bootstrap: true,
	capture: true,
	ensureMemoryReady: true,
	getRuntime: true,
	session_before_compact: true,
	session_shutdown: true,
	session_start: true,
	session_switch: true,
};

export interface IsolatedRun {
	activeTools: string[];
	log(message: string): void;
	record(record: Record<string, unknown>): void;
	assertOpen(): void;
	track<T>(operation: Promise<T>): Promise<T>;
	close(): Promise<void>;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function errorCategory(error: unknown): string {
	if (error instanceof TypeError) return "TypeError";
	if (error instanceof RangeError) return "RangeError";
	if (error instanceof Error) return "Error";
	return "NonError";
}

export function createIsolatedRun(env: NodeJS.ProcessEnv = process.env): IsolatedRun | null {
	const rootValue = env[ROOT_ENV];
	const toolsValue = env[TOOLS_ENV];
	if (rootValue === undefined && toolsValue === undefined) return null;
	if (rootValue === undefined || toolsValue === undefined) throw new Error(`${ROOT_ENV} and ${TOOLS_ENV} must be set together`);
	if (!isAbsolute(rootValue)) throw new Error(`${ROOT_ENV} must be an absolute path`);
	let activeTools: unknown;
	try {
		activeTools = JSON.parse(toolsValue);
	} catch {
		throw new Error(`${TOOLS_ENV} must be a JSON array of unique non-empty strings`);
	}
	if (!Array.isArray(activeTools) || activeTools.some((name) => typeof name !== "string" || name.length === 0 || name.trim() !== name) || new Set(activeTools).size !== activeTools.length) {
		throw new Error(`${TOOLS_ENV} must be a JSON array of unique non-empty strings`);
	}

	const root = resolve(rootValue);
	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("isolated run root must be an existing real directory");
	if (typeof process.getuid !== "function" || rootStat.uid !== process.getuid()) throw new Error("isolated run root must be owned by the effective user");
	if ((rootStat.mode & 0o022) !== 0 || realpathSync(root) !== root) throw new Error("isolated run root has unsafe permissions or resolves through symlinks");
	const target = join(root, LOG_NAME);
	let targetExists = false;
	try {
		lstatSync(target);
		targetExists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (targetExists) throw new Error("isolated run log target already exists");
	const fd = openSync(target, "wx", 0o600);
	try {
		fchmodSync(fd, 0o600);
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	let closing = false;
	let closed = false;
	let closePromise: Promise<void> | null = null;
	const pending = new Set<Promise<void>>();
	const writeRecord = (record: Record<string, unknown>) => {
		if (closed) throw new Error("isolated run log is closed");
		writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
	};
	const assertOpen = () => {
		if (closing || closed) throw new Error("isolated run log is closing or closed");
	};
	const track = <T>(operation: Promise<T>): Promise<T> => {
		if (closed) throw new Error("isolated run log is closed");
		const drained = operation.then(() => undefined, () => undefined);
		pending.add(drained);
		void drained.finally(() => pending.delete(drained));
		return operation;
	};
	return {
		activeTools: activeTools as string[],
		record: writeRecord,
		assertOpen,
		track,
		log(message) {
			const delimiter = message.indexOf(":");
			const prefix = delimiter < 0 ? "" : message.slice(0, delimiter);
			const category = LOG_CATEGORIES[prefix] ? prefix : "extension";
			writeRecord({ type: "extension_log", category, message_hash: hash(message) });
		},
		close() {
			if (closePromise) return closePromise;
			closePromise = (async () => {
				// Tracked high-level operations may still need nested SDK requests.
				while (pending.size > 0) await Promise.all([...pending]);
				closing = true;
				closed = true;
				closeSync(fd);
			})();
			return closePromise;
		},
	};
}

export async function applyActiveTools(pi: {
	getAllTools(): Array<{ name: string }>;
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): Promise<void>;
}, requested: readonly string[]): Promise<void> {
	const available = pi.getAllTools().map((tool) => tool.name);
	if (new Set(requested).size !== requested.length) throw new Error("configured active tool names must be unique");
	for (const name of requested) {
		if (!available.includes(name)) throw new Error(`configured active tool is unavailable: ${name}`);
	}
	await pi.setActiveTools([...requested]);
	const actual = pi.getActiveTools();
	const expectedNames = new Set(requested);
	if (actual.length !== requested.length || new Set(actual).size !== actual.length || actual.some((name) => !expectedNames.has(name))) {
		throw new Error("OMP active tool readback does not match isolated policy");
	}
}

export function attachIsolatedHonchoTelemetry(honcho: Honcho, run: IsolatedRun): void {
	const http = honcho.http;
	let sequence = 0;
	const instrument = (methodName: "request" | "stream" | "upload") => {
		const original = http[methodName] as (...args: unknown[]) => Promise<unknown>;
		(http as unknown as Record<string, unknown>)[methodName] = function (this: unknown, ...args: unknown[]) {
			run.assertOpen();
			const suppliedMethod = methodName === "upload" ? "POST" : String(args[0]).toUpperCase();
			const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(suppliedMethod) ? suppliedMethod : "OTHER";
			const path = String(args[methodName === "upload" ? 0 : 1] ?? "");
			const requestId = `${process.pid}-${++sequence}-${randomUUID()}`;
			const startedAt = Date.now();
			const classification = method === "GET" || method === "HEAD" ? "method_read" : "method_write";
			run.record({ type: "sdk_operation", phase: "started", request_id: requestId, method, classification, path_hash: hash(path) });
			let result: Promise<unknown>;
			try {
				result = original.apply(this, args);
			} catch (error) {
				run.record({ type: "sdk_operation", phase: "error", request_id: requestId, error_category: errorCategory(error), duration_ms: Date.now() - startedAt });
				throw error;
			}
			const tracked = result.then(
				(value) => {
					run.record({ type: "sdk_operation", phase: "completed", request_id: requestId, duration_ms: Date.now() - startedAt });
					return value;
				},
				(error: unknown) => {
					run.record({ type: "sdk_operation", phase: "error", request_id: requestId, error_category: errorCategory(error), duration_ms: Date.now() - startedAt });
					throw error;
				},
			);
			return run.track(tracked);
		};
	};
	instrument("request");
	instrument("stream");
	instrument("upload");
}
