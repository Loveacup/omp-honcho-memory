import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evaluateMemoryCandidate,
	JUDGE_MAX_INPUT_BYTES,
	TYPESAFE_DEFAULT_MODEL,
	type JudgeConfig,
} from "../extensions/memory-judge.js";

type Handler = (request: Request, body: unknown) => Response | Promise<Response>;

interface Received {
	// Parsed JSON request body as sent by the code under test.
	body: any;
	authorization: string | null;
}

let handler: Handler = () => new Response("unset", { status: 500 });
let received: Received[] = [];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const body = await request.json().catch(() => null);
		received.push({ body, authorization: request.headers.get("authorization") });
		return handler(request, body);
	},
});
const origin = `http://127.0.0.1:${server.port}`;
const typesafe = (extra: Partial<JudgeConfig> = {}): JudgeConfig => ({ provider: "typesafe", endpoint: `${origin}/v1/systemone`, ...extra });
const compatible = (extra: Partial<JudgeConfig> = {}): JudgeConfig => ({
	provider: "openai-compatible",
	endpoint: `${origin}/v1/chat/completions`,
	model: "local-judge",
	...extra,
});
const input = { id: "c1", text: "我长期偏好中文简洁回答" };

function noulBody(taskRequest: unknown, stableUserFact: unknown, model = TYPESAFE_DEFAULT_MODEL): Response {
	return Response.json({
		model,
		answers: {
			taskRequest: { type: "noul", noul: taskRequest },
			stableUserFact: { type: "noul", noul: stableUserFact },
		},
		usage: { input_tokens: 120, output_tokens: 8 },
	});
}

function chatBody(content: string, model: unknown = "local-judge"): Response {
	return Response.json({ model, choices: [{ message: { role: "assistant", content } }] });
}

function stalledBody(): Response {
	return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }), {
		headers: { "Content-Type": "application/json" },
	});
}

const roots: string[] = [];
afterAll(() => {
	server.stop(true);
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
	received = [];
});

describe("evaluateMemoryCandidate", () => {
	test("off and a missing provider never fetch", async () => {
		let calls = 0;
		const fetchImpl = (async () => { calls++; return new Response(); }) as unknown as typeof fetch;
		const off = await evaluateMemoryCandidate(input, { provider: "off", endpoint: "not a url" }, { fetchImpl });
		const missing = await evaluateMemoryCandidate(input, {} as JudgeConfig, { fetchImpl });
		expect(off.status).toBe("disabled");
		expect(missing).toMatchObject({ status: "disabled", provider: "off" });
		expect(calls).toBe(0);
	});

	test("sends the fixed TypeSafe request and returns both noul signals unchanged", async () => {
		handler = () => noulBody(0.12, 0.91);
		const result = await evaluateMemoryCandidate(input, typesafe({ apiKey: "k" }));
		expect(result).toMatchObject({
			status: "ok",
			provider: "typesafe",
			model: TYPESAFE_DEFAULT_MODEL,
			signalKind: "noul",
			signals: { taskRequest: 0.12, stableUserFact: 0.91 },
			inputTokens: 120,
			outputTokens: 8,
		});
		expect(received).toHaveLength(1);
		const sent = received[0];
		expect(sent.authorization).toBe("Bearer k");
		expect(sent.body.model).toBe(TYPESAFE_DEFAULT_MODEL);
		expect(sent.body.state).toEqual({ text: input.text });
		expect(Object.keys(sent.body.questions).sort()).toEqual(["stableUserFact", "taskRequest"]);
		expect(sent.body.questions.taskRequest.type).toBe("noul");
	});

	test("accepts the 0 and 1 noul boundaries", async () => {
		handler = () => noulBody(0, 1);
		const result = await evaluateMemoryCandidate(input, typesafe());
		expect(result.signals).toEqual({ taskRequest: 0, stableUserFact: 1 });
	});

	test("rejects out-of-range, missing, extra or mismatched-model TypeSafe answers", async () => {
		const bad: Response[] = [
			noulBody(1.01, 0.5),
			noulBody(-0.01, 0.5),
			noulBody("0.5", 0.5),
			noulBody(0.5, 0.5, "jev-latest"),
			Response.json({ model: TYPESAFE_DEFAULT_MODEL, answers: { taskRequest: { type: "noul", noul: 0.5 } } }),
			Response.json({
				model: TYPESAFE_DEFAULT_MODEL,
				answers: {
					taskRequest: { type: "noul", noul: 0.5 },
					stableUserFact: { type: "noul", noul: 0.5 },
					extra: { type: "noul", noul: 0.5 },
				},
			}),
			Response.json({
				model: TYPESAFE_DEFAULT_MODEL,
				answers: { taskRequest: { type: "score", noul: 0.5 }, stableUserFact: { type: "noul", noul: 0.5 } },
			}),
		];
		for (const response of bad) {
			handler = () => response;
			const result = await evaluateMemoryCandidate(input, typesafe());
			expect(result.status).toBe("error");
			expect(result.signals).toBeUndefined();
		}
	});

	test("omits usage it did not receive instead of reporting zero", async () => {
		handler = () => Response.json({
			model: TYPESAFE_DEFAULT_MODEL,
			answers: { taskRequest: { type: "noul", noul: 0.4 }, stableUserFact: { type: "noul", noul: 0.6 } },
		});
		const result = await evaluateMemoryCandidate(input, typesafe());
		expect(result.status).toBe("ok");
		expect("inputTokens" in result).toBe(false);
		expect("outputTokens" in result).toBe(false);
	});

	test("maps openai-compatible booleans to a binary signal, never a noul probability", async () => {
		handler = () => Response.json({
			model: "served-model",
			choices: [{ message: { content: JSON.stringify({ taskRequest: true, stableUserFact: false }) } }],
			usage: { prompt_tokens: 50, completion_tokens: 9 },
		});
		const result = await evaluateMemoryCandidate(input, compatible());
		expect(result).toMatchObject({
			status: "ok",
			model: "served-model",
			signalKind: "binary",
			signals: { taskRequest: 1, stableUserFact: 0 },
			inputTokens: 50,
			outputTokens: 9,
		});
		const sent = received[0];
		expect(sent.authorization).toBeNull();
		expect(sent.body.stream).toBe(false);
		expect(sent.body.messages[1]).toEqual({ role: "user", content: JSON.stringify({ text: input.text }) });
		expect("logprobs" in sent.body || "response_format" in sent.body).toBe(false);
	});

	test("rejects openai-compatible content that is not exactly the two-boolean JSON object", async () => {
		const bad = [
			chatBody("```json\n{\"taskRequest\":true,\"stableUserFact\":false}\n```"),
			chatBody("taskRequest: true"),
			chatBody(JSON.stringify({ taskRequest: true })),
			chatBody(JSON.stringify({ taskRequest: true, stableUserFact: false, note: "x" })),
			chatBody(JSON.stringify({ taskRequest: 0.9, stableUserFact: 0.1 })),
			chatBody(JSON.stringify({ taskRequest: true, stableUserFact: false }), ""),
		];
		for (const response of bad) {
			handler = () => response;
			const result = await evaluateMemoryCandidate(input, compatible());
			expect(result.status).toBe("error");
			expect(result.signals).toBeUndefined();
		}
	});

	test("rejects invalid input and configuration before any request", async () => {
		const cases: Array<[typeof input, JudgeConfig]> = [
			[{ id: "c1", text: "   " }, typesafe()],
			[{ id: "", text: "x" }, typesafe()],
			[{ id: "c1", text: "a".repeat(JUDGE_MAX_INPUT_BYTES + 1) }, typesafe()],
			[input, { provider: "typesafe" }],
			[input, typesafe({ endpoint: "http://example.com/v1/systemone", apiKey: "k" })],
			[input, typesafe({ endpoint: `${origin}/v1/systemone?x=1` })],
			[input, typesafe({ endpoint: `http://user:pw@127.0.0.1:${server.port}/` })],
			[input, compatible({ endpoint: undefined })],
			[input, compatible({ model: undefined })],
		];
		for (const [candidate, config] of cases) {
			const result = await evaluateMemoryCandidate(candidate, config);
			expect(result.status).toBe("error");
		}
		expect(received).toHaveLength(0);
	});

	test("reports HTTP failures and redirects as errors after a single request", async () => {
		handler = () => new Response("secret body", { status: 500 });
		const failed = await evaluateMemoryCandidate(input, typesafe());
		expect(failed).toMatchObject({ status: "error", error: "judge endpoint returned HTTP 500" });
		handler = () => new Response(null, { status: 302, headers: { Location: `${origin}/elsewhere` } });
		const redirected = await evaluateMemoryCandidate(input, typesafe());
		expect(redirected.status).toBe("error");
		expect(received).toHaveLength(2);
	});

	test("attempts an unreachable endpoint at most once", async () => {
		let calls = 0;
		const fetchImpl = ((...args: Parameters<typeof fetch>) => { calls++; return fetch(...args); }) as typeof fetch;
		const result = await evaluateMemoryCandidate(input, typesafe({ endpoint: "http://127.0.0.1:1/v1/systemone" }), { fetchImpl });
		expect(result.status).toBe("error");
		expect(calls).toBe(1);
	});

	// The judge has a fixed real 2000 ms deadline over a real loopback fetch, so
	// these two cases deliberately run against the platform clock.
	test("times out a stalled body and never reports a late response as ok", async () => {
		handler = () => stalledBody();
		const stalled = await evaluateMemoryCandidate(input, typesafe());
		expect(stalled.status).toBe("timeout");
		let release: () => void = () => {};
		handler = () => new Promise<Response>((resolve) => { release = () => resolve(noulBody(0.1, 0.9)); });
		const late = await evaluateMemoryCandidate(input, typesafe());
		release();
		expect(late.status).toBe("timeout");
		expect(late.signals).toBeUndefined();
		expect(received).toHaveLength(2);
	}, 10_000);

	test("an external abort is a cancelled error, not a timeout", async () => {
		const controller = new AbortController();
		handler = () => {
			controller.abort();
			return stalledBody();
		};
		const result = await evaluateMemoryCandidate(input, typesafe(), { signal: controller.signal });
		expect(result).toMatchObject({ status: "error", error: "cancelled" });
		expect(received).toHaveLength(1);
	});
});

describe("memory-judge CLI", () => {
	const root = mkdtempSync(join(tmpdir(), "memory-judge-cli-"));
	roots.push(root);
	const inputFile = join(root, "input.json");
	writeFileSync(inputFile, JSON.stringify(input));
	const script = join(import.meta.dir, "..", "scripts", "memory-judge.ts");

	async function run(args: string[], env: Record<string, string> = {}) {
		const child = Bun.spawn([process.execPath, script, ...args], {
			env: { PATH: process.env.PATH ?? "", HOME: root, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	}

	test("off and an omitted provider print disabled and exit 0 without a request", async () => {
		for (const args of [["--provider", "off", "--input", inputFile], ["--input", inputFile]]) {
			const out = await run(args, { TYPESAFE_API_KEY: "k" });
			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout)).toMatchObject({ id: "c1", status: "disabled", provider: "off" });
		}
		expect(received).toHaveLength(0);
	});

	test("valid provider runs print ok and exit 0 after exactly one request each", async () => {
		handler = () => noulBody(0.2, 0.8);
		const ts = await run(["--provider", "typesafe", "--endpoint", `${origin}/v1/systemone`, "--input", inputFile], { TYPESAFE_API_KEY: "ts-key" });
		expect(ts.code).toBe(0);
		expect(JSON.parse(ts.stdout).status).toBe("ok");
		expect(received[0].authorization).toBe("Bearer ts-key");
		handler = () => chatBody(JSON.stringify({ taskRequest: false, stableUserFact: true }));
		const oc = await run(
			["--provider", "openai-compatible", "--endpoint", `${origin}/v1/chat/completions`, "--model", "local-judge", "--input", inputFile],
			{ TYPESAFE_API_KEY: "ts-key" },
		);
		expect(oc.code).toBe(0);
		expect(JSON.parse(oc.stdout)).toMatchObject({ status: "ok", signalKind: "binary" });
		expect(received[1].authorization).toBeNull();
		expect(received).toHaveLength(2);
	});

	test("configuration rejections print an error result and exit 1 without a request", async () => {
		const out = await run(["--provider", "typesafe", "--input", inputFile]);
		expect(out.code).toBe(1);
		expect(JSON.parse(out.stdout).status).toBe("error");
		expect(received).toHaveLength(0);
	});

	test("invalid arguments or input exit 2 with the fixed stderr line and no request", async () => {
		const badShape = join(root, "bad.json");
		writeFileSync(badShape, JSON.stringify({ id: "c1", text: "x", extra: 1 }));
		const notJson = join(root, "bad.txt");
		writeFileSync(notJson, "{");
		const blankText = join(root, "blank.json");
		writeFileSync(blankText, JSON.stringify({ id: "c1", text: "   " }));
		const cases = [
			["--provider", "typesafe"],
			["--provider", "other", "--input", inputFile],
			["--input", inputFile, "--input", inputFile],
			["--unknown", "x", "--input", inputFile],
			["--input"],
			["--input", join(root, "missing.json")],
			["--input", badShape],
			["--input", notJson],
			["--input", blankText],
		];
		for (const args of cases) {
			const out = await run(args);
			expect(out).toEqual({ stdout: "", stderr: "Invalid arguments or input.\n", code: 2 });
		}
		expect(received).toHaveLength(0);
	});

	test("server failures and stalled bodies exit 1 after exactly one request", async () => {
		handler = () => new Response("no", { status: 500 });
		const failed = await run(["--provider", "typesafe", "--endpoint", `${origin}/v1/systemone`, "--input", inputFile]);
		expect(failed.code).toBe(1);
		expect(JSON.parse(failed.stdout).status).toBe("error");
		expect(received).toHaveLength(1);
		received = [];
		handler = () => stalledBody();
		const stalled = await run(["--provider", "typesafe", "--endpoint", `${origin}/v1/systemone`, "--input", inputFile]);
		expect(stalled.code).toBe(1);
		expect(JSON.parse(stalled.stdout).status).toBe("timeout");
		expect(received).toHaveLength(1);
	}, 10_000);
});
