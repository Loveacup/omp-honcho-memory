#!/usr/bin/env bun
/**
 * Explicit evaluation entry for the optional memory candidate judge.
 *
 *   bun scripts/memory-judge.ts --provider off|typesafe|openai-compatible \
 *     [--endpoint URL] [--model ID] --input PATH
 *
 * PATH holds a JSON object with exactly the string fields `id` and `text`, each
 * non-blank. The provider defaults to `off`. Keys come only from TYPESAFE_API_KEY
 * (typesafe) or MEMORY_JUDGE_API_KEY (openai-compatible); `off` reads none.
 * Invalid arguments or input print a fixed stderr line, nothing on stdout, and
 * exit 2 without network access. Otherwise one JudgeResult JSON line is printed;
 * `ok`/`disabled` exit 0, everything else exits 1. This command writes no files,
 * starts no background process, and never contacts Honcho.
 */
import { readFileSync } from "node:fs";
import { evaluateMemoryCandidate, type JudgeConfig, type JudgeInput, type JudgeProvider } from "../extensions/memory-judge.js";

const PROVIDERS: readonly JudgeProvider[] = ["off", "typesafe", "openai-compatible"];
const FLAGS = new Set(["--provider", "--endpoint", "--model", "--input"]);

function parseArgs(argv: readonly string[]): Map<string, string> | null {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!FLAGS.has(flag) || values.has(flag) || value === undefined || value.startsWith("--")) return null;
		values.set(flag, value);
	}
	return values;
}

function readInput(path: string): JudgeInput | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== 2 || !keys.includes("id") || !keys.includes("text")) return null;
	if (typeof record.id !== "string" || record.id.trim().length === 0) return null;
	if (typeof record.text !== "string" || record.text.trim().length === 0) return null;
	return { id: record.id, text: record.text };
}

const args = parseArgs(process.argv.slice(2));
const provider = (args?.get("--provider") ?? "off") as JudgeProvider;
const inputPath = args?.get("--input");
const input = args && inputPath !== undefined && PROVIDERS.includes(provider) ? readInput(inputPath) : null;
if (!input) {
	process.stderr.write("Invalid arguments or input.\n");
	process.exit(2);
}

const config: JudgeConfig = { provider, endpoint: args?.get("--endpoint"), model: args?.get("--model") };
if (provider === "typesafe") config.apiKey = process.env.TYPESAFE_API_KEY || undefined;
if (provider === "openai-compatible") config.apiKey = process.env.MEMORY_JUDGE_API_KEY || undefined;

const result = await evaluateMemoryCandidate(input, config);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.status === "ok" || result.status === "disabled" ? 0 : 1);
