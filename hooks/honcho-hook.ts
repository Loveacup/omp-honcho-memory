import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { classifyEntry, stripInjectedUserText, type EntryClass, type HonchoHost } from "../core/source.js";
import { createHonchoHandles, type HonchoHandles } from "../extensions/client.js";
import { isConfigured, resolveConfigForHost } from "../extensions/config.js";
import { compileMemoryContext, hydrateMemoryContext } from "../extensions/memory.js";
import { formatHonchoMemoryBlock, formatRawRecall } from "../extensions/raw-recall.js";
import { searchWorkspaceMessages } from "../extensions/raw-search.js";
import { sanitizeForSessionName } from "../extensions/session-key.js";

const HOOK_TIMEOUT_MS = 7800;
const CONTEXT_BUDGET = 6000;
type HookEvent = "session-start" | "user-prompt" | "stop";
type JsonObject = Record<string, unknown>;

interface ParsedArgs {
	host: Exclude<HonchoHost, "omp">;
	event: HookEvent;
	dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
	const hostIndex = argv.indexOf("--host");
	const host = hostIndex >= 0 ? argv[hostIndex + 1] : undefined;
	const event = argv.find((arg) => arg === "session-start" || arg === "user-prompt" || arg === "stop");
	if ((host !== "claude_code" && host !== "codex") || !event) {
		throw new Error("usage: honcho-hook.mjs --host <claude_code|codex> <session-start|user-prompt|stop> [--dry-run]");
	}
	return { host, event, dryRun: argv.includes("--dry-run") };
}

async function readPayload(): Promise<Record<string, unknown>> {
	let input = "";
	for await (const chunk of process.stdin) input += String(chunk);
	if (!input.trim()) return {};
	const parsed: unknown = JSON.parse(input);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hook input must be a JSON object");
	return parsed as Record<string, unknown>;
}

function logLine(event: HookEvent, detail: string): void {
	try {
		const file = `${homedir()}/.honcho/cognition/hook.log`;
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `[${new Date().toISOString()}] ${event}: ${detail}\n`);
	} catch {}
}

function payloadString(payload: Record<string, unknown>, field: string): string | null {
	const value = payload[field];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function sessionKey(host: Exclude<HonchoHost, "omp">, payload: Record<string, unknown>): string | null {
	const nativeSessionId = payloadString(payload, "session_id");
	if (!nativeSessionId) return null;
	return `${sanitizeForSessionName(host)}-${sanitizeForSessionName(nativeSessionId)}`;
}

async function handlesFor(host: Exclude<HonchoHost, "omp">, payload: Record<string, unknown>): Promise<HonchoHandles | null> {
	const cwd = payloadString(payload, "cwd") ?? process.cwd();
	const config = resolveConfigForHost(host, cwd);
	if (!isConfigured(config)) return null;
	const key = sessionKey(host, payload);
	if (!key) return null;
	return createHonchoHandles({ config, sessionKey: key });
}

function metadata(host: Exclude<HonchoHost, "omp">, entryClass: EntryClass, payload: Record<string, unknown>): Record<string, string> | null {
	const nativeSessionId = payloadString(payload, "session_id");
	if (!nativeSessionId) return null;
	return { host, entry_class: entryClass, host_session_id: nativeSessionId };
}

let stdoutFinalized = false;
function writeJsonOutput(value: JsonObject): void {
	if (stdoutFinalized) return;
	stdoutFinalized = true;
	writeFileSync(1, JSON.stringify(value));
}

function hookOutput(eventName: "SessionStart" | "UserPromptSubmit", additionalContext: string): void {
	writeJsonOutput({ hookSpecificOutput: { hookEventName: eventName, additionalContext } });
}

async function sessionStart(host: Exclude<HonchoHost, "omp">, payload: Record<string, unknown>): Promise<void> {
	const handles = await handlesFor(host, payload);
	if (!handles) return;
	const block = await hydrateMemoryContext(handles);
	const compiled = compileMemoryContext(block, null);
	if (compiled) hookOutput("SessionStart", formatHonchoMemoryBlock(compiled, host, CONTEXT_BUDGET));
}

async function userPrompt(host: Exclude<HonchoHost, "omp">, payload: Record<string, unknown>, entryClass: EntryClass): Promise<void> {
	const prompt = payloadString(payload, "prompt");
	if (!prompt) return;
	const stripped = stripInjectedUserText(prompt);
	const handles = await handlesFor(host, payload);
	if (!handles) return;
	const source = metadata(host, entryClass, payload);
	if (entryClass === "user_interactive" && stripped && source && handles.config.saveMessages !== false) {
		await handles.session.addMessages([handles.userPeer.message(stripped, { metadata: source })]);
	}
	if (handles.config.injectPerPrompt === false) return;
	const recalled = await searchWorkspaceMessages(
		{ apiKey: handles.config.apiKey, baseUrl: handles.config.url, workspaceId: handles.config.workspace },
		prompt,
		{ target: "all" },
	);
	const formatted = formatRawRecall(recalled, CONTEXT_BUDGET - 128);
	hookOutput("UserPromptSubmit", formatHonchoMemoryBlock(formatted, host, CONTEXT_BUDGET));
}

async function stop(host: Exclude<HonchoHost, "omp">, payload: Record<string, unknown>, entryClass: EntryClass): Promise<void> {
	if (entryClass !== "user_interactive") return;
	const assistant = payloadString(payload, "last_assistant_message");
	const source = metadata(host, entryClass, payload);
	if (!assistant || !source) return;
	const handles = await handlesFor(host, payload);
	if (!handles || handles.config.saveMessages === false) return;
	await handles.session.addMessages([handles.aiPeer.message(assistant, { metadata: source })]);
}

function dryRunSummary(args: ParsedArgs, payload: Record<string, unknown>, entryClass: EntryClass): void {
	const cwd = payloadString(payload, "cwd") ?? process.cwd();
	const config = resolveConfigForHost(args.host, cwd);
	const configured = isConfigured(config) && sessionKey(args.host, payload) !== null;
	const prompt = payloadString(payload, "prompt");
	const strippedPrompt = prompt ? stripInjectedUserText(prompt) : null;
	const assistant = payloadString(payload, "last_assistant_message");
	const wouldWrite = configured && config.saveMessages !== false && entryClass === "user_interactive" && (
		(args.event === "user-prompt" && strippedPrompt !== null) ||
		(args.event === "stop" && assistant !== null)
	);
	const wouldInject = configured && (
		args.event === "session-start" ||
		(args.event === "user-prompt" && config.injectPerPrompt !== false && prompt !== null)
	);
	writeJsonOutput({
		host: args.host,
		event: args.event,
		entry_class: entryClass,
		would_write: wouldWrite,
		would_inject: wouldInject,
	});
}

async function run(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const payload = await readPayload();
	const entryClass = classifyEntry({ host: args.host, payload });
	if (args.dryRun) {
		dryRunSummary(args, payload, entryClass);
		return;
	}
	if (!payloadString(payload, "session_id")) {
		logLine(args.event, "missing_session_id");
		return;
	}
	if (args.event === "user-prompt" && !payloadString(payload, "prompt")) {
		logLine(args.event, "missing_prompt");
		return;
	}
	if (entryClass === "unknown" && args.event !== "session-start") {
		logLine(args.event, "unknown_entry_class");
	}
	if (args.event === "session-start") await sessionStart(args.host, payload);
	else if (args.event === "user-prompt") await userPrompt(args.host, payload, entryClass);
	else await stop(args.host, payload, entryClass);
}

async function main(): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	let timedOut = false;
	try {
		await Promise.race([
			run(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					timedOut = true;
					reject(new Error("hook timeout"));
				}, HOOK_TIMEOUT_MS);
			}),
		]);
	} catch (error) {
		const event = process.argv.find((arg) => arg === "session-start" || arg === "user-prompt" || arg === "stop") as HookEvent | undefined;
		const kind = error instanceof Error ? error.name : "Error";
		logLine(event ?? "user-prompt", kind);
		writeJsonOutput({});
		if (timedOut) process.exit(0);
	} finally {
		clearTimeout(timer);
	}
}

await main();
