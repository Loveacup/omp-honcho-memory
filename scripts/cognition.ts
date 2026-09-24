import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isConfigured, resolveConfigForHost } from "../extensions/config.js";

type Host = "claude_code" | "codex";
type EventName = "SessionStart" | "UserPromptSubmit" | "Stop";
type JsonObject = Record<string, unknown>;

interface FileChange {
	target: string;
	operation: "write" | "move";
	previousSha256: string | null;
	newSha256: string | null;
	backup: string | null;
}

interface RemovedHook {
	event: string;
	groupIndex: number;
	handlerIndex: number;
	groupFields: JsonObject;
	handler: JsonObject;
}

interface JsonChange {
	target: string;
	previousSha256: string | null;
	newSha256: string;
	backup: string | null;
	removed: RemovedHook[];
	added: RemovedHook[];
	pluginFlag?: { existed: boolean; previous: unknown; installed: false };
}

interface JournalEntry {
	operation: string;
	status: "started" | "done";
}

interface RefreshRecord {
	id: string;
	action: "install" | "upgrade";
	status: "in_progress" | "complete" | "rolled_back";
	previousNodePath: string;
	nodePath: string;
	files: FileChange[];
	json: JsonChange[];
	completedOps: JournalEntry[];
}

interface Manifest {
	schema: "honcho-cognition-backup.v1";
	createdAt: string;
	action: "install" | "upgrade";
	status: "in_progress" | "complete" | "rolled_back";
	completedOps: JournalEntry[];
	nodePath: string;
	mcp: { name: "honcho-memory"; bundlePath: string };
	refreshes: RefreshRecord[];
	uninstalledAt?: string;
	files: FileChange[];
	json: JsonChange[];
}

interface PlannedFile extends FileChange {
	content?: Buffer;
}

const repo = resolve(import.meta.dir, "..");
const home = homedir();
const cognitionDir = join(home, ".honcho", "cognition");
const backupRoot = join(cognitionDir, "backup");
const ompTarget = join(home, ".omp", "agent", "extensions", "honcho-memory.js");
const hookTarget = join(cognitionDir, "honcho-hook.mjs");
const mcpTarget = join(cognitionDir, "honcho-mcp.mjs");
const claudeSettings = join(home, ".claude", "settings.json");
const codexHooks = join(home, ".codex", "hooks.json");
const codexLegacy = join(home, ".codex", "honcho", "codex-honcho.mjs");
const hermesRepo = join(home, ".hermes", "hermes-agent");
const distOmp = join(repo, "dist", "index.js");
const distHook = join(repo, "dist", "honcho-hook.mjs");
const distMcp = join(repo, "dist", "honcho-mcp.mjs");
const events: EventName[] = ["SessionStart", "UserPromptSubmit", "Stop"];

function sha256Buffer(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function sha256File(path: string): string | null {
	return existsSync(path) ? sha256Buffer(readFileSync(path)) : null;
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, null, 2) + "\n";
}

function readJson(path: string): JsonObject {
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`expected JSON object: ${path}`);
	return parsed as JsonObject;
}

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function shellQuote(path: string): string {
	return `'${path.replace(/'/g, `'"'"'`)}'`;
}

function resolveNodePath(): string {
	for (const directory of (process.env.PATH ?? "").split(":")) {
		if (!directory) continue;
		const candidate = join(directory, "node");
		try {
			accessSync(candidate, constants.X_OK);
			return resolve(candidate);
		} catch {}
	}
	throw new Error("node executable not found on PATH");
}


function hookCommand(nodePath: string, host: Host, event: EventName): string {
	const eventArg = event === "SessionStart" ? "session-start" : event === "UserPromptSubmit" ? "user-prompt" : "stop";
	return `${shellQuote(nodePath)} ${shellQuote(hookTarget)} --host ${host} ${eventArg}`;
}

function canonicalHandler(nodePath: string, host: Host, event: EventName): JsonObject {
	return {
		type: "command",
		command: hookCommand(nodePath, host, event),
		timeout: event === "UserPromptSubmit" ? 10 : 8,
	};
}

function commandOf(handler: unknown): string {
	if (!handler || typeof handler !== "object" || Array.isArray(handler)) return "";
	const command = (handler as JsonObject).command;
	return typeof command === "string" ? command : "";
}

function hooksObject(document: JsonObject): JsonObject {
	if (!document.hooks || typeof document.hooks !== "object" || Array.isArray(document.hooks)) document.hooks = {};
	return document.hooks as JsonObject;
}

function removeMatching(document: JsonObject, predicate: (command: string) => boolean): RemovedHook[] {
	const removed: RemovedHook[] = [];
	const hooks = hooksObject(document);
	for (const event of Object.keys(hooks)) {
		const groups = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
		const nextGroups: unknown[] = [];
		groups.forEach((rawGroup, groupIndex) => {
			if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) {
				nextGroups.push(rawGroup);
				return;
			}
			const group = rawGroup as JsonObject;
			const handlers = Array.isArray(group.hooks) ? group.hooks as unknown[] : [];
			const kept: unknown[] = [];
			const groupFields = jsonClone(group);
			delete groupFields.hooks;
			handlers.forEach((rawHandler, handlerIndex) => {
				if (predicate(commandOf(rawHandler)) && rawHandler && typeof rawHandler === "object" && !Array.isArray(rawHandler)) {
					removed.push({ event, groupIndex, handlerIndex, groupFields, handler: jsonClone(rawHandler as JsonObject) });
				} else kept.push(rawHandler);
			});
			if (kept.length > 0 || handlers.length === 0) nextGroups.push({ ...group, hooks: kept });
		});
		hooks[event] = nextGroups;
	}
	return removed;
}

function addCanonical(document: JsonObject, nodePath: string, host: Host): RemovedHook[] {
	const hooks = hooksObject(document);
	const added: RemovedHook[] = [];
	for (const event of events) {
		const groups = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
		const handler = canonicalHandler(nodePath, host, event);
		const groupIndex = groups.length;
		groups.push({ hooks: [handler] });
		hooks[event] = groups;
		added.push({ event, groupIndex, handlerIndex: 0, groupFields: {}, handler });
	}
	return added;
}

function prepareClaude(nodePath: string): { document: JsonObject; change: JsonChange } {
	const document = readJson(claudeSettings);
	const previousSha256 = sha256File(claudeSettings);
	const removed = removeMatching(document, (command) => command.includes("honcho-hook.mjs") && command.includes("--host claude_code"));
	const enabled = document.enabledPlugins && typeof document.enabledPlugins === "object" && !Array.isArray(document.enabledPlugins)
		? document.enabledPlugins as JsonObject
		: {};
	const existed = Object.prototype.hasOwnProperty.call(enabled, "honcho@honcho");
	const previous = existed ? jsonClone(enabled["honcho@honcho"]) : null;
	enabled["honcho@honcho"] = false;
	document.enabledPlugins = enabled;
	const added = addCanonical(document, nodePath, "claude_code");
	const content = Buffer.from(stableJson(document));
	return {
		document,
		change: {
			target: claudeSettings,
			previousSha256,
			newSha256: sha256Buffer(content),
			removed,
			added,
			backup: existsSync(claudeSettings) ? backupName(claudeSettings) : null,
			pluginFlag: { existed, previous, installed: false },
		},
	};
}

function prepareCodex(nodePath: string, refresh = false): { document: JsonObject; change: JsonChange } {
	const document = readJson(codexHooks);
	const previousSha256 = sha256File(codexHooks);
	const removed = removeMatching(document, (command) =>
		(command.includes("honcho-hook.mjs") && command.includes("--host codex")) ||
		(!refresh && command.includes("codex-honcho.mjs")),
	);
	const added = addCanonical(document, nodePath, "codex");
	const content = Buffer.from(stableJson(document));
	return {
		document,
		change: {
			target: codexHooks,
			previousSha256,
			newSha256: sha256Buffer(content),
			removed,
			added,
			backup: existsSync(codexHooks) ? backupName(codexHooks) : null,
		},
	};
}

function backupName(target: string): string {
	const digest = createHash("sha256").update(target).digest("hex").slice(0, 12);
	return join("files", `${digest}-${basename(target)}`);
}

function planWrite(target: string, content: Buffer): PlannedFile {
	return {
		target,
		operation: "write",
		previousSha256: sha256File(target),
		newSha256: sha256Buffer(content),
		backup: existsSync(target) ? backupName(target) : null,
		content,
	};
}

function planMove(target: string): PlannedFile {
	return {
		target,
		operation: "move",
		previousSha256: sha256File(target),
		newSha256: null,
		backup: backupName(target),
	};
}

// The Hermes provider cleanup (R39/R40 removal) was a one-time step of the first
// install. Hermes' own `hermes update` now manages that checkout, so installs no
// longer touch it and uninstall never re-applies the old patches.
const hermesProviderDir = join(hermesRepo, "plugins", "memory", "honcho");

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function printFilePlan(change: FileChange): void {
	console.log(`FILE ${change.operation} ${change.target} previous=${change.previousSha256 ?? "absent"} new=${change.newSha256 ?? "absent"}`);
}

function printJsonPlan(change: JsonChange): void {
	console.log(`JSON ${change.target} previous=${change.previousSha256 ?? "absent"} new=${change.newSha256}`);
	if (change.pluginFlag) console.log(`  enabledPlugins.honcho@honcho ${String(change.pluginFlag.previous)} -> false`);
	for (const item of change.removed) console.log(`  REMOVE ${item.event} ${JSON.stringify(item.handler)}`);
	for (const item of change.added) console.log(`  ADD ${item.event} ${JSON.stringify(item.handler)}`);
}

function mcpAddArgs(nodePath: string): string[] {
	return ["mcp", "add", "--scope", "user", "honcho-memory", "--", nodePath, mcpTarget];
}

function printMcpCommand(verb: "add" | "remove", nodePath?: string): void {
	const args = verb === "add"
		? mcpAddArgs(nodePath!)
		: ["mcp", "remove", "--scope", "user", "honcho-memory"];
	console.log(`MCP ${verb.toUpperCase()} claude ${args.map(shellQuote).join(" ")}`);
}

function claudeMcpState(nodePath: string): "absent" | "identical" | "different" {
	const result = spawnSync("claude", ["mcp", "get", "honcho-memory"], { encoding: "utf8" });
	if (result.error) throw new Error("claude executable not available");
	if (result.status !== 0) return "absent";
	const output = `${String(result.stdout)}\n${String(result.stderr)}`;
	return output.includes(nodePath) && output.includes(mcpTarget) ? "identical" : "different";
}

function runClaudeMcp(args: string[]): void {
	const result = spawnSync("claude", args, { encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error(`claude ${args[1] ?? "mcp"} failed`);
}

function writeManifest(dir: string, manifest: Manifest): void {
	const target = join(dir, "manifest.json");
	const temporary = `${target}.tmp`;
	writeFileSync(temporary, stableJson(manifest));
	renameSync(temporary, target);
}

function updateJournal(
	entries: JournalEntry[],
	dir: string,
	manifest: Manifest,
	operation: string,
	status: "started" | "done",
): void {
	if (status === "started") entries.push({ operation, status });
	else {
		const entry = [...entries].reverse().find((item) => item.operation === operation && item.status === "started");
		if (!entry) throw new Error(`journal operation was not started: ${operation}`);
		entry.status = "done";
	}
	writeManifest(dir, manifest);
}

function journaled(
	operation: string,
	update: (operation: string, status: "started" | "done") => void,
	mutate: () => void,
): void {
	update(operation, "started");
	mutate();
	update(operation, "done");
}

function backupChanges(
	dir: string,
	files: FileChange[],
	json: JsonChange[],
	update: (operation: string, status: "started" | "done") => void,
): void {
	files.forEach((change, index) => {
		if (!change.backup) return;
		const backup = join(dir, change.backup);
		journaled(`backup:file:${index}`, update, () => {
			mkdirSync(dirname(backup), { recursive: true });
			copyFileSync(change.target, backup);
		});
	});
	json.forEach((change, index) => {
		if (!change.backup) return;
		const backup = join(dir, change.backup);
		journaled(`backup:json:${index}`, update, () => {
			mkdirSync(dirname(backup), { recursive: true });
			copyFileSync(change.target, backup);
		});
	});
}

function applyFileChange(change: PlannedFile): void {
	if (change.operation === "move") {
		rmSync(change.target);
		return;
	}
	mkdirSync(dirname(change.target), { recursive: true });
	writeFileSync(change.target, change.content!);
}

function reportConflict(
	path: string,
	dir: string,
	change: { backup: string | null },
	conflicts: string[],
): void {
	const backup = change.backup ? join(dir, change.backup) : "none";
	console.error(`CONFLICT ${path} backup=${backup}`);
	conflicts.push(path);
}

function reverseFileChange(
	dir: string,
	change: FileChange,
	conflicts: string[],
	apply: boolean,
): "none" | "restore" | "conflict" {
	const current = sha256File(change.target);
	if (current === change.previousSha256) return "none";
	if (current !== change.newSha256) {
		reportConflict(change.target, dir, change, conflicts);
		return "conflict";
	}
	if (!apply) return "restore";
	if (change.previousSha256 === null) {
		rmSync(change.target, { force: true });
		return "restore";
	}
	if (!change.backup || sha256File(join(dir, change.backup)) !== change.previousSha256) {
		reportConflict(change.target, dir, change, conflicts);
		return "conflict";
	}
	mkdirSync(dirname(change.target), { recursive: true });
	copyFileSync(join(dir, change.backup), change.target);
	return "restore";
}

function rollbackInitial(dir: string, manifest: Manifest): void {
	const conflicts: string[] = [];
	for (const entry of [...manifest.completedOps].reverse()) {
		const operation = entry.operation;
		if (operation === "mcp:add") {
			const state = claudeMcpState(manifest.nodePath);
			if (state === "identical") runClaudeMcp(["mcp", "remove", "--scope", "user", "honcho-memory"]);
			else if (state === "different") reportConflict("claude:mcp:honcho-memory", dir, { backup: null }, conflicts);
		} else if (operation.startsWith("json:")) {
			reverseJsonChange(dir, manifest.json[Number(operation.slice(5))], conflicts, true);
		} else if (operation.startsWith("file:")) {
			reverseFileChange(dir, manifest.files[Number(operation.slice(5))], conflicts, true);
		}
	}
	if (conflicts.length > 0) throw new Error(`rollback conflicts: ${conflicts.length}`);
	manifest.status = "rolled_back";
	manifest.uninstalledAt = new Date().toISOString();
	writeManifest(dir, manifest);
}

function withRefreshBackup<T extends FileChange | JsonChange>(change: T, refreshId: string): T {
	return {
		...change,
		backup: change.backup ? join("refreshes", refreshId, change.backup) : null,
	};
}

function rollbackRefresh(dir: string, manifest: Manifest, refresh: RefreshRecord): void {
	const conflicts: string[] = [];
	for (const entry of [...refresh.completedOps].reverse()) {
		const operation = entry.operation;
		if (operation === "mcp:add-new") {
			const state = claudeMcpState(refresh.nodePath);
			if (state === "identical") runClaudeMcp(["mcp", "remove", "--scope", "user", "honcho-memory"]);
			else if (state === "different") reportConflict("claude:mcp:honcho-memory", dir, { backup: null }, conflicts);
		} else if (operation === "mcp:remove-old") {
			const state = claudeMcpState(refresh.previousNodePath);
			if (state === "absent") runClaudeMcp(mcpAddArgs(refresh.previousNodePath));
			else if (state === "different") reportConflict("claude:mcp:honcho-memory", dir, { backup: null }, conflicts);
		} else if (operation.startsWith("json:")) {
			reverseJsonChange(dir, refresh.json[Number(operation.slice(5))], conflicts, true);
		} else if (operation.startsWith("file:")) {
			reverseFileChange(dir, refresh.files[Number(operation.slice(5))], conflicts, true);
		}
	}
	if (conflicts.length > 0) throw new Error(`rollback conflicts: ${conflicts.length}`);
	refresh.status = "rolled_back";
	manifest.status = "complete";
	writeManifest(dir, manifest);
}

function applyRefresh(
	active: { dir: string; manifest: Manifest },
	action: "install" | "upgrade",
	nodePath: string,
	dryRun: boolean,
): void {
	const plannedFiles: PlannedFile[] = [
		planWrite(ompTarget, readFileSync(distOmp)),
		planWrite(hookTarget, readFileSync(distHook)),
		planWrite(mcpTarget, readFileSync(distMcp)),
	];
	const claude = prepareClaude(nodePath);
	const codex = prepareCodex(nodePath, true);
	const preparedJson = [claude, codex];
	for (const file of plannedFiles) printFilePlan(file);
	for (const prepared of preparedJson) printJsonPlan(prepared.change);
	printMcpCommand("add", nodePath);
	if (dryRun) return;

	const previousMcp = claudeMcpState(active.manifest.nodePath);
	if (previousMcp === "different") throw new Error("Claude MCP name honcho-memory no longer matches this install");
	const refreshId = timestamp();
	const refresh: RefreshRecord = {
		id: refreshId,
		action,
		status: "in_progress",
		previousNodePath: active.manifest.nodePath,
		nodePath,
		files: plannedFiles.map(({ content: _content, ...change }) => withRefreshBackup(change, refreshId)),
		json: preparedJson.map(({ change }) => withRefreshBackup(change, refreshId)),
		completedOps: [],
	};
	active.manifest.status = "in_progress";
	active.manifest.refreshes.push(refresh);
	writeManifest(active.dir, active.manifest);
	const update = (operation: string, status: "started" | "done") => {
		updateJournal(refresh.completedOps, active.dir, active.manifest, operation, status);
	};
	try {
		backupChanges(active.dir, refresh.files, refresh.json, update);
		plannedFiles.forEach((file, index) => {
			journaled(`file:${index}`, update, () => applyFileChange(file));
		});
		preparedJson.forEach((prepared, index) => {
			journaled(`json:${index}`, update, () => {
				writeFileSync(prepared.change.target, stableJson(prepared.document));
			});
		});
		if (previousMcp === "identical" && refresh.previousNodePath !== nodePath) {
			journaled("mcp:remove-old", update, () => {
				runClaudeMcp(["mcp", "remove", "--scope", "user", "honcho-memory"]);
			});
		}
		const nextMcp = claudeMcpState(nodePath);
		if (nextMcp === "different") throw new Error("Claude MCP name honcho-memory is registered differently");
		if (nextMcp === "absent") {
			journaled("mcp:add-new", update, () => runClaudeMcp(mcpAddArgs(nodePath)));
		}
		for (const changed of refresh.files) {
			const baseline = active.manifest.files.find((item) => item.target === changed.target);
			if (baseline) baseline.newSha256 = changed.newSha256;
		}
		refresh.json.forEach((changed) => {
			const baseline = active.manifest.json.find((item) => item.target === changed.target);
			if (baseline) {
				baseline.newSha256 = changed.newSha256;
				baseline.added = changed.added;
			}
		});
		active.manifest.nodePath = nodePath;
		refresh.status = "complete";
		active.manifest.status = "complete";
		writeManifest(active.dir, active.manifest);
	} catch (error) {
		rollbackRefresh(active.dir, active.manifest, refresh);
		throw error;
	}
}

function applyInstall(action: "install" | "upgrade", dryRun: boolean): void {
	if (!existsSync(distOmp) || !existsSync(distHook) || !existsSync(distMcp)) {
		throw new Error("build artifacts missing; run bun run build first");
	}
	const nodePath = resolveNodePath();
	const active = latestManifest();
	if (active) {
		if ((active.manifest.status ?? "complete") !== "complete") {
			if (dryRun) throw new Error("active install transaction is incomplete; run uninstall to recover it");
			recoverPending(active);
			const recovered = latestManifest();
			if (recovered) return applyRefresh(recovered, action, nodePath, false);
		} else {
			return applyRefresh(active, action, nodePath, dryRun);
		}
	}

	const files: PlannedFile[] = [
		planWrite(ompTarget, readFileSync(distOmp)),
		planWrite(hookTarget, readFileSync(distHook)),
		planWrite(mcpTarget, readFileSync(distMcp)),
	];
	if (existsSync(codexLegacy)) files.push(planMove(codexLegacy));
	const claude = prepareClaude(nodePath);
	const codex = prepareCodex(nodePath);
	const preparedJson = [claude, codex];
	for (const file of files) printFilePlan(file);
	for (const prepared of preparedJson) printJsonPlan(prepared.change);
	printMcpCommand("add", nodePath);
	if (dryRun) return;

	const mcpState = claudeMcpState(nodePath);
	if (mcpState === "different") throw new Error("Claude MCP name honcho-memory is already registered differently");
	mkdirSync(backupRoot, { recursive: true });
	const backupDir = join(backupRoot, timestamp());
	mkdirSync(backupDir, { recursive: false });
	const manifest: Manifest = {
		schema: "honcho-cognition-backup.v1",
		createdAt: new Date().toISOString(),
		action,
		status: "in_progress",
		completedOps: [],
		nodePath,
		mcp: { name: "honcho-memory", bundlePath: mcpTarget },
		refreshes: [],
		files: files.map(({ content: _content, ...change }) => change),
		json: preparedJson.map(({ change }) => change),
	};
	writeManifest(backupDir, manifest);
	const update = (operation: string, status: "started" | "done") => {
		updateJournal(manifest.completedOps, backupDir, manifest, operation, status);
	};
	try {
		backupChanges(backupDir, manifest.files, manifest.json, update);
		files.forEach((file, index) => {
			journaled(`file:${index}`, update, () => applyFileChange(file));
		});
		preparedJson.forEach((prepared, index) => {
			journaled(`json:${index}`, update, () => {
				mkdirSync(dirname(prepared.change.target), { recursive: true });
				writeFileSync(prepared.change.target, stableJson(prepared.document));
			});
		});
		if (mcpState === "absent") {
			journaled("mcp:add", update, () => runClaudeMcp(mcpAddArgs(nodePath)));
		}
		manifest.status = "complete";
		writeManifest(backupDir, manifest);
		console.log(`MANIFEST ${join(backupDir, "manifest.json")}`);
	} catch (error) {
		rollbackInitial(backupDir, manifest);
		throw error;
	}
}

function normalizeJournal(value: unknown): JournalEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: JournalEntry[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			entries.push({ operation: item, status: "done" });
		} else if (
			item &&
			typeof item === "object" &&
			typeof (item as Partial<JournalEntry>).operation === "string" &&
			((item as Partial<JournalEntry>).status === "started" || (item as Partial<JournalEntry>).status === "done")
		) {
			entries.push(item as JournalEntry);
		}
	}
	return entries;
}

function latestManifest(): { dir: string; manifest: Manifest } | null {
	if (!existsSync(backupRoot)) return null;
	const candidates = readdirSync(backupRoot)
		.map((name) => join(backupRoot, name))
		.filter((dir) => existsSync(join(dir, "manifest.json")))
		.sort()
		.reverse();
	for (const dir of candidates) {
		const parsed = readJson(join(dir, "manifest.json")) as unknown as Manifest;
		if (parsed.schema !== "honcho-cognition-backup.v1" || parsed.uninstalledAt || parsed.status === "rolled_back") continue;
		parsed.status ??= "complete";
		parsed.completedOps = normalizeJournal(parsed.completedOps);
		parsed.refreshes ??= [];
		for (const refresh of parsed.refreshes) refresh.completedOps = normalizeJournal(refresh.completedOps);
		for (const change of parsed.json) change.backup ??= null;
		return { dir, manifest: parsed };
	}
	return null;
}

function recoverPending(active: { dir: string; manifest: Manifest }): void {
	if (active.manifest.status !== "in_progress") return;
	const refresh = [...active.manifest.refreshes].reverse().find((item) => item.status === "in_progress");
	if (refresh) rollbackRefresh(active.dir, active.manifest, refresh);
	else rollbackInitial(active.dir, active.manifest);
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function removeAdded(document: JsonObject, change: JsonChange): boolean {
	if (!document.hooks || typeof document.hooks !== "object" || Array.isArray(document.hooks)) return false;
	const hooks = document.hooks as JsonObject;
	let changed = false;
	for (const added of change.added) {
		const installedCommand = commandOf(added.handler);
		const host = installedCommand.includes("--host claude_code")
			? "claude_code"
			: installedCommand.includes("--host codex")
				? "codex"
				: null;
		const groups = Array.isArray(hooks[added.event]) ? hooks[added.event] as unknown[] : [];
		const next: unknown[] = [];
		for (const rawGroup of groups) {
			if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) {
				next.push(rawGroup);
				continue;
			}
			const group = rawGroup as JsonObject;
			const handlers = Array.isArray(group.hooks) ? group.hooks as unknown[] : [];
			const kept = handlers.filter((handler) => {
				const command = commandOf(handler);
				const owned = host
					? command.includes("honcho-hook.mjs") && command.includes(`--host ${host}`)
					: deepEqual(handler, added.handler);
				if (!owned) return true;
				changed = true;
				return false;
			});
			if (kept.length > 0 || handlers.length === 0) next.push({ ...group, hooks: kept });
		}
		if (!deepEqual(groups, next)) hooks[added.event] = next;
	}
	return changed;
}

function hasEventHandler(document: JsonObject, event: string, handler: JsonObject): boolean {
	if (!document.hooks || typeof document.hooks !== "object" || Array.isArray(document.hooks)) return false;
	const groups = Array.isArray((document.hooks as JsonObject)[event])
		? (document.hooks as JsonObject)[event] as unknown[]
		: [];
	return groups.some((group) =>
		group &&
		typeof group === "object" &&
		!Array.isArray(group) &&
		Array.isArray((group as JsonObject).hooks) &&
		((group as JsonObject).hooks as unknown[]).some((candidate) => deepEqual(candidate, handler))
	);
}

function restoreRemoved(document: JsonObject, change: JsonChange): boolean {
	let changed = false;
	for (const removed of [...change.removed].sort((a, b) => a.groupIndex - b.groupIndex || a.handlerIndex - b.handlerIndex)) {
		if (hasEventHandler(document, removed.event, removed.handler)) continue;
		const hooks = hooksObject(document);
		const groups = Array.isArray(hooks[removed.event]) ? hooks[removed.event] as unknown[] : [];
		let group = groups.find((candidate) => {
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
			const candidateFields = { ...(candidate as JsonObject) };
			delete candidateFields.hooks;
			return deepEqual(candidateFields, removed.groupFields);
		});
		if (!group) {
			group = { ...removed.groupFields, hooks: [] };
			groups.splice(Math.min(removed.groupIndex, groups.length), 0, group);
		}
		const target = group as JsonObject;
		const handlers = Array.isArray(target.hooks) ? target.hooks as unknown[] : [];
		handlers.splice(Math.min(removed.handlerIndex, handlers.length), 0, jsonClone(removed.handler));
		target.hooks = handlers;
		hooks[removed.event] = groups;
		changed = true;
	}
	return changed;
}

function reverseJsonChange(
	dir: string,
	change: JsonChange,
	conflicts: string[],
	apply: boolean,
): JsonObject | null {
	const conflictsBefore = conflicts.length;
	let document: JsonObject;
	try {
		document = readJson(change.target);
	} catch {
		reportConflict(change.target, dir, change, conflicts);
		return null;
	}
	let changed = removeAdded(document, change);
	changed = restoreRemoved(document, change) || changed;
	if (change.pluginFlag) {
		const enabled = document.enabledPlugins &&
			typeof document.enabledPlugins === "object" &&
			!Array.isArray(document.enabledPlugins)
			? document.enabledPlugins as JsonObject
			: null;
		const exists = enabled !== null && Object.prototype.hasOwnProperty.call(enabled, "honcho@honcho");
		const previousMatches = change.pluginFlag.existed
			? exists && deepEqual(enabled!["honcho@honcho"], change.pluginFlag.previous)
			: !exists;
		const installedMatches = exists && enabled!["honcho@honcho"] === change.pluginFlag.installed;
		if (!previousMatches && installedMatches) {
			if (change.pluginFlag.existed) enabled!["honcho@honcho"] = jsonClone(change.pluginFlag.previous);
			else delete enabled!["honcho@honcho"];
			changed = true;
		} else if (!previousMatches) {
			reportConflict(`${change.target}:enabledPlugins.honcho@honcho`, dir, change, conflicts);
		}
	}
	// Untouched since install: restore the original bytes exactly. Otherwise keep the surgical result.
	const backup = change.backup ? join(dir, change.backup) : null;
	const pristine = sha256File(change.target) === change.newSha256 && backup !== null &&
		sha256File(backup) === change.previousSha256 && conflicts.length === conflictsBefore;
	if (apply && pristine) copyFileSync(backup!, change.target);
	else if (apply && changed) writeFileSync(change.target, stableJson(document));
	return document;
}

function applyUninstall(dryRun: boolean): void {
	let latest = latestManifest();
	if (!latest) {
		console.log("PLAN NOOP no active cognition install manifest; no files or JSON entries would change");
		return;
	}
	if (latest.manifest.status === "in_progress") {
		if (dryRun) {
			console.log("PLAN recover incomplete cognition transaction, then uninstall original baseline");
			return;
		}
		recoverPending(latest);
		latest = latestManifest();
		if (!latest) {
			console.log("RECOVERED incomplete initial install; original state restored");
			return;
		}
	}
	const conflicts: string[] = [];
	for (const file of [...latest.manifest.files].reverse()) {
		if (file.target.startsWith(`${hermesProviderDir}/`)) {
			console.log(`KEEP ${file.target} one-way Hermes cleanup; backup=${file.backup ? join(latest.dir, file.backup) : "none"}`);
			continue;
		}
		const current = sha256File(file.target);
		reverseFileChange(latest.dir, file, conflicts, !dryRun);
		console.log(`FILE restore ${file.target} current=${current ?? "absent"} restored=${file.previousSha256 ?? "absent"}`);
	}
	for (const change of latest.manifest.json) {
		const current = sha256File(change.target);
		const document = reverseJsonChange(latest.dir, change, conflicts, !dryRun);
		if (!document) continue;
		const nextSha = dryRun ? sha256Buffer(Buffer.from(stableJson(document))) : sha256File(change.target);
		console.log(`JSON restore ${change.target} current=${current ?? "absent"} new=${nextSha}`);
		for (const item of change.added) console.log(`  REMOVE ${item.event} ${JSON.stringify(item.handler)}`);
		for (const item of change.removed) console.log(`  ADD ${item.event} ${JSON.stringify(item.handler)}`);
	}
	printMcpCommand("remove");
	if (!dryRun) {
		const mcpState = claudeMcpState(latest.manifest.nodePath);
		if (mcpState === "different") {
			reportConflict("claude:mcp:honcho-memory", latest.dir, { backup: null }, conflicts);
		} else if (mcpState === "identical") {
			runClaudeMcp(["mcp", "remove", "--scope", "user", "honcho-memory"]);
		}
	}
	if (conflicts.length > 0) throw new Error(`uninstall conflicts: ${conflicts.length}`);
	if (dryRun) return;
	latest.manifest.status = "rolled_back";
	latest.manifest.uninstalledAt = new Date().toISOString();
	writeManifest(latest.dir, latest.manifest);
}

function countHandlers(document: JsonObject, predicate: (command: string) => boolean): Record<EventName, number> {
	const counts: Record<EventName, number> = { SessionStart: 0, UserPromptSubmit: 0, Stop: 0 };
	const hooks = document.hooks && typeof document.hooks === "object" && !Array.isArray(document.hooks) ? document.hooks as JsonObject : {};
	for (const event of events) {
		const groups = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
		for (const group of groups) {
			if (!group || typeof group !== "object" || Array.isArray(group)) continue;
			const handlers = Array.isArray((group as JsonObject).hooks) ? (group as JsonObject).hooks as unknown[] : [];
			for (const handler of handlers) if (predicate(commandOf(handler))) counts[event]++;
		}
	}
	return counts;
}

function hasHandler(document: JsonObject, predicate: (command: string) => boolean): boolean {
	const hooks = document.hooks && typeof document.hooks === "object" && !Array.isArray(document.hooks) ? document.hooks as JsonObject : {};
	for (const rawGroups of Object.values(hooks)) {
		if (!Array.isArray(rawGroups)) continue;
		for (const group of rawGroups) {
			if (!group || typeof group !== "object" || Array.isArray(group)) continue;
			const handlers = Array.isArray((group as JsonObject).hooks) ? (group as JsonObject).hooks as unknown[] : [];
			if (handlers.some((handler) => predicate(commandOf(handler)))) return true;
		}
	}
	return false;
}

function allOne(counts: Record<EventName, number>): boolean {
	return events.every((event) => counts[event] === 1);
}

function dryHook(host: Host, nodePath: string | null): boolean {
	if (!nodePath || !existsSync(nodePath) || !existsSync(hookTarget)) return false;
	const payload = JSON.stringify({ session_id: "smoke-session", cwd: repo, prompt: "synthetic prompt" });
	const result = spawnSync(nodePath, [hookTarget, "--host", host, "user-prompt", "--dry-run"], {
		input: payload,
		encoding: "utf8",
		env: { ...process.env, HONCHO_AUTOMATION: "1" },
	});
	if (result.status !== 0) return false;
	try {
		const summary = JSON.parse(result.stdout) as JsonObject;
		return summary.host === host && summary.entry_class === "automation" && summary.would_write === false;
	} catch {
		return false;
	}
}

function report(host: string, fatal: boolean, configured: boolean, dryRunOk: boolean, details: Record<string, boolean> = {}): void {
	const status = fatal ? "FAIL" : configured && dryRunOk ? "PASS" : "DEGRADED";
	const suffix = Object.entries(details).map(([name, value]) => ` ${name}=${String(value)}`).join("");
	console.log(`${status} ${host} installed=${String(!fatal)} config=${String(configured)} dry_run=${String(dryRunOk)}${suffix}`);
}

async function mcpDrySmoke(nodePath: string, bundlePath: string): Promise<boolean> {
	const transport = new StdioClientTransport({
		command: nodePath,
		args: [bundlePath, "--dry-run"],
		stderr: "pipe",
	});
	const client = new Client({ name: "honcho-cognition-smoke", version: "0.4.0" });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			(async () => {
				await client.connect(transport);
				return client.listTools();
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("MCP smoke timed out")), 8_000);
			}),
		]);
		const actual = result.tools.map((tool) => tool.name).sort();
		const expected = [
			"honcho_add_conclusion",
			"honcho_delete_conclusion",
			"honcho_list_conclusions",
			"honcho_search",
		];
		return JSON.stringify(actual) === JSON.stringify(expected);
	} catch {
		return false;
	} finally {
		if (timer) clearTimeout(timer);
		await client.close().catch(() => {});
	}
}

async function smoke(): Promise<void> {
	const active = latestManifest();
	const nodePath = active?.manifest.nodePath ?? null;
	const nodePathOk = nodePath !== null && existsSync(nodePath);
	const hookHashOk = sha256File(hookTarget) !== null && sha256File(hookTarget) === sha256File(distHook);
	const mcpHashOk = sha256File(mcpTarget) !== null && sha256File(mcpTarget) === sha256File(distMcp);
	const ompHashOk = sha256File(ompTarget) !== null && sha256File(ompTarget) === sha256File(distOmp);
	const ompConfigured = isConfigured(resolveConfigForHost("omp", repo));
	report("omp", !ompHashOk, ompConfigured, true);

	let claudeHooksOk = false;
	let claudePluginOff = false;
	try {
		const document = readJson(claudeSettings);
		const counts = countHandlers(document, (command) => command.includes("honcho-hook.mjs") && command.includes("--host claude_code"));
		claudeHooksOk = allOne(counts);
		const enabled = document.enabledPlugins && typeof document.enabledPlugins === "object" && !Array.isArray(document.enabledPlugins) ? document.enabledPlugins as JsonObject : {};
		claudePluginOff = enabled["honcho@honcho"] === false;
	} catch {}
	let mcpRegistrationOk = false;
	if (nodePath) {
		try {
			mcpRegistrationOk = claudeMcpState(nodePath) === "identical";
		} catch {}
	}
	const mcpBundle = existsSync(mcpTarget) ? mcpTarget : distMcp;
	const mcpToolsOk = nodePathOk && existsSync(mcpBundle) && await mcpDrySmoke(nodePath!, mcpBundle);
	report(
		"claude_code",
		!hookHashOk || !mcpHashOk || !claudeHooksOk || !claudePluginOff || !mcpRegistrationOk,
		isConfigured(resolveConfigForHost("claude_code", repo)),
		dryHook("claude_code", nodePath) && mcpToolsOk,
		{ node: nodePathOk, mcp: mcpRegistrationOk, mcp_tools: mcpToolsOk },
	);

	let codexHooksOk = false;
	const legacyAbsent = !existsSync(codexLegacy);
	try {
		const document = readJson(codexHooks);
		const counts = countHandlers(document, (command) => command.includes("honcho-hook.mjs") && command.includes("--host codex"));
		codexHooksOk = allOne(counts) && !hasHandler(document, (command) => command.includes("codex-honcho.mjs"));
	} catch {}
	report(
		"codex",
		!hookHashOk || !codexHooksOk || !legacyAbsent,
		isConfigured(resolveConfigForHost("codex", repo)),
		dryHook("codex", nodePath),
		{ node: nodePathOk },
	);
	// Ask Hermes itself (its venv, its dotenv loader, honouring HERMES_HOME) whether Honcho memory is live.
	const hermesPy = join(hermesRepo, "venv", "bin", "python");
	const probe = spawnSync(hermesPy, ["-c", [
		"from hermes_cli.env_loader import load_hermes_dotenv; load_hermes_dotenv()",
		"from hermes_cli.config import load_config",
		"m = (load_config() or {}).get('memory') or {}",
		"from plugins.memory.honcho.client import HonchoClientConfig",
		"c = HonchoClientConfig.from_global_config()",
		"print(int(m.get('provider') == 'honcho' and m.get('memory_enabled', True) is not False and bool(c.enabled) and bool(c.api_key or c.base_url)))",
	].join("\n")], { cwd: hermesRepo, encoding: "utf8", timeout: 15000 });
	const hermesConfigured = probe.status === 0 && String(probe.stdout).trim().endsWith("1");
	const hermesClean = existsSync(hermesRepo) && !existsSync(join(hermesProviderDir, "r40_runtime.py"));
	// `hermes update` resets local commits away; the machine-author gate then silently disappears.
	// Machine-author patch persists via Hermes `updates.parked_branch_strategy: update_in_place`; this is the backstop check.
	const turnAuthor = join(hermesRepo, "agent", "turn_author.py");
	const machineGate = existsSync(turnAuthor) && readFileSync(turnAuthor, "utf8").includes("def machine_turn_author");
	report("hermes", !hermesClean, hermesConfigured, machineGate, { machine_gate: machineGate, memory_live: hermesConfigured });
}

async function main(): Promise<void> {
	const [action, ...flags] = process.argv.slice(2);
	const dryRun = flags.includes("--dry-run");
	if (flags.some((flag) => flag !== "--dry-run")) throw new Error("unsupported flag");
	if (action === "install" || action === "upgrade") applyInstall(action, dryRun);
	else if (action === "uninstall") applyUninstall(dryRun);
	else if (action === "smoke") await smoke();
	else throw new Error("usage: bun scripts/cognition.ts <install|upgrade|uninstall|smoke> [--dry-run]");
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : "cognition command failed");
	process.exitCode = 1;
}
