import { describe, expect, test } from "bun:test";
import { hookUserText } from "../hooks/prompt-filter.js";

const CONTINUATION = [
	"Continue work from the prior Orca session using the context below.",
	"The prior provider session is read-only context; do not resume or modify it.",
	"",
	"Original agent: claude",
	"Session: hook smoke",
	"Original working directory: /tmp/hooksmoke-cc",
	"",
	"Latest Orca status hints:",
	"Last assistant update: placeholder.",
].join("\n");

const DISPATCH = [
	"You are working inside Orca, a multi-agent IDE. You are a dispatched worker.",
	"Your coordinator's terminal handle is: term_1234",
	"Your task ID is: task_5678",
].join("\n");

// Claude Code wraps pasted multi-line input like this (observed 2.1.280).
const pasted = (body: string) => `<pasted_content id="db2f">\n${body}\n</pasted_content id="db2f">`;

describe("hook user text admission", () => {
	test("complete Orca continuation and dispatch envelopes are rejected", () => {
		expect(hookUserText(CONTINUATION)).toBeNull();
		expect(hookUserText(DISPATCH)).toBeNull();
	});

	test("an envelope pasted into Claude Code is rejected through the pasted_content wrapper", () => {
		expect(hookUserText(pasted(CONTINUATION))).toBeNull();
		expect(hookUserText(`  ${pasted(DISPATCH)}\n`)).toBeNull();
	});

	test("a partial envelope signature is withheld as ambiguous", () => {
		expect(hookUserText("Continue work from the prior Orca session using the context below.\nOriginal agent: codex")).toBeNull();
	});

	test("human text, including a bare template opener or pasted ordinary text, is kept", () => {
		expect(hookUserText("部署冒烟测试短句：请只回复收到")).toBe("部署冒烟测试短句：请只回复收到");
		const opener = "Continue work from the prior Orca session using the context below.";
		expect(hookUserText(opener)).toBe(opener);
		const note = pasted("def gcd(a, b):\n    return a if b == 0 else gcd(b, a % b)");
		expect(hookUserText(note)).toBe(note);
	});

	test("human text that only quotes an envelope after its own words is kept", () => {
		const text = `看看这个模板：\n${pasted(CONTINUATION)}`;
		expect(hookUserText(text)).toBe(text);
	});

	test("several pasted blocks are not merged into one envelope", () => {
		const opener = "Continue work from the prior Orca session using the context below.";
		const text = `${pasted(opener)}\n${pasted("Original agent: codex")}`;
		expect(hookUserText(text)).toBe(text);
	});

	test("host-injected leading blocks stay rejected", () => {
		expect(hookUserText("<system-reminder>\ninjected\n</system-reminder>")).toBeNull();
	});
});
