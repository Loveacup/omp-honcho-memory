import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyActiveTools, createIsolatedRun } from "../extensions/isolated-run.js";

const roots: string[] = [];

function privateRoot(): string {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "omp-honcho-isolated-"));
	roots.push(root);
	return root;
}

function envFor(root: string, activeTools = "[]"): NodeJS.ProcessEnv {
	return {
		HONCHO_ISOLATED_RUN_DIR: root,
		HONCHO_ISOLATED_ACTIVE_TOOLS: activeTools,
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("isolated run policy", () => {
	test("leaves policy disabled without either opt-in variable", () => {
		expect(createIsolatedRun({})).toBeNull();
	});

	test("requires both environment settings and rejects malformed or duplicate tool names", () => {
		expect(() => createIsolatedRun({ HONCHO_ISOLATED_RUN_DIR: privateRoot() })).toThrow();
		expect(() => createIsolatedRun({ HONCHO_ISOLATED_ACTIVE_TOOLS: "[]" })).toThrow();
		for (const invalid of ["not-json", "{}", "[1]", '["read","read"]', '[" read"]']) {
			expect(() => createIsolatedRun(envFor(privateRoot(), invalid))).toThrow();
		}
	});

	test("refuses an existing or symlinked deterministic log target without changing its target", async () => {
		const existingRoot = privateRoot();
		const existing = join(existingRoot, "honcho-plugin.jsonl");
		await Bun.write(existing, "preexisting-marker");
		expect(() => createIsolatedRun(envFor(existingRoot))).toThrow();
		expect(readFileSync(existing, "utf8")).toBe("preexisting-marker");

		const symlinkRoot = privateRoot();
		const target = join(symlinkRoot, "outside.jsonl");
		await Bun.write(target, "symlink-marker");
		symlinkSync(target, join(symlinkRoot, "honcho-plugin.jsonl"));
		expect(() => createIsolatedRun(envFor(symlinkRoot))).toThrow();
		expect(readFileSync(target, "utf8")).toBe("symlink-marker");
	});

	test("creates a private log and omits original message canaries", async () => {
		const root = privateRoot();
		const run = createIsolatedRun(envFor(root));
		if (!run) throw new Error("expected isolated run policy");
		run.log("canary-secret-user-prompt no delimiter");
		run.log("canary-secret-user-prompt: prompt");
		await run.close();
		const logPath = join(root, "honcho-plugin.jsonl");
		expect(lstatSync(logPath).mode & 0o777).toBe(0o600);
		const contents = readFileSync(logPath, "utf8");
		expect(contents).not.toContain("canary-secret-user-prompt");
		expect(contents).toContain('"message_hash"');
	});

	test("concurrent close waits for high-level callbacks before closing the log", async () => {
		const root = privateRoot();
		const run = createIsolatedRun(envFor(root));
		if (!run) throw new Error("expected isolated run policy");
		const pending = Promise.withResolvers<void>();
		const message = "session_start: background failure handled";
		run.track(pending.promise.then(async () => {
			await Promise.resolve();
			run.log(message);
		}));
		let drained = false;
		const firstClose = run.close().then(() => { drained = true; });
		const secondClose = run.close();
		await Promise.resolve();
		expect(drained).toBe(false);
		pending.resolve();
		await Promise.all([firstClose, secondClose]);
		expect(drained).toBe(true);
		const record = JSON.parse(readFileSync(join(root, "honcho-plugin.jsonl"), "utf8"));
		expect(record.category).toBe("session_start");
		expect(record.message_hash).toBe(createHash("sha256").update(message).digest("hex"));
		expect(() => run.log("session_start: late callback")).toThrow("closed");
	});

	test("rejects unknown tools and validates exact active sets independent of order", async () => {
		let active = ["read", "write"];
		let setCalls = 0;
		const pi = {
			getAllTools: () => [{ name: "read" }, { name: "write" }],
			getActiveTools: () => [...active],
			setActiveTools: async (names: string[]) => { setCalls++; active = names; },
		};
		await expect(applyActiveTools(pi, ["missing"])).rejects.toThrow();
		expect(setCalls).toBe(0);
		await expect(applyActiveTools(pi, ["read", "read"])).rejects.toThrow();
		expect(setCalls).toBe(0);
		await expect(applyActiveTools({ ...pi, setActiveTools: async () => { setCalls++; } }, ["read"])).rejects.toThrow();
		await applyActiveTools({ ...pi, setActiveTools: async (names) => { active = [...names].reverse(); } }, ["read", "write"]);
		await expect(applyActiveTools({ ...pi, setActiveTools: async () => { active = ["read", "read"]; } }, ["read", "write"])).rejects.toThrow();
		await expect(applyActiveTools({ ...pi, setActiveTools: async () => { active = ["read", "other"]; } }, ["read", "write"])).rejects.toThrow();
	});
});
