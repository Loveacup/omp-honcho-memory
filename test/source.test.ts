import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyEntry, stripInjectedUserText, type AncestorLookup } from "../core/source.js";
import { resolveConfigForHost } from "../extensions/config.js";

function ancestry(rows: Record<number, { ppid: number; args: string }>): AncestorLookup {
	return (pid) => rows[pid] ?? null;
}

describe("entry classification precedence", () => {
	test("automation marker wins over an interactive OMP context", () => {
		expect(classifyEntry({
			host: "omp",
			env: { HONCHO_AUTOMATION: "1" },
			omp: { mode: "tui", hasUI: true },
		})).toBe("automation");
	});

	test("OMP non-tui and no-UI contexts are automation", () => {
		expect(classifyEntry({ host: "omp", env: {}, omp: { mode: "print", hasUI: true } })).toBe("automation");
		expect(classifyEntry({ host: "omp", env: {}, omp: { mode: "tui", hasUI: false } })).toBe("automation");
	});

	test("Claude subagent payload is automation", () => {
		expect(classifyEntry({ host: "claude_code", env: {}, payload: { agent_id: "child" } })).toBe("automation");
	});

	test("Claude print ancestor is automation", () => {
		expect(classifyEntry({
			host: "claude_code",
			env: {},
			pid: 100,
			lookupAncestor: ancestry({
				100: { ppid: 99, args: "node honcho-hook.mjs" },
				99: { ppid: 1, args: "/opt/homebrew/bin/claude -p --output-format json" },
			}),
		})).toBe("automation");
	});


	test("plain Claude ancestor is user interactive", () => {
		expect(classifyEntry({
			host: "claude_code",
			env: {},
			pid: 100,
			lookupAncestor: ancestry({
				100: { ppid: 99, args: "node honcho-hook.mjs" },
				99: { ppid: 1, args: "/opt/homebrew/bin/claude" },
			}),
		})).toBe("user_interactive");
	});
	test("Codex exec ancestor is automation", () => {
		expect(classifyEntry({
			host: "codex",
			env: {},
			pid: 100,
			lookupAncestor: ancestry({
				100: { ppid: 99, args: "node honcho-hook.mjs" },
				99: { ppid: 1, args: "/opt/homebrew/bin/codex exec run" },
			}),
		})).toBe("automation");
	});

	test("Codex parses global options before its subcommand", () => {
		const classify = (args: string) => classifyEntry({
			host: "codex",
			env: {},
			pid: 100,
			lookupAncestor: ancestry({
				100: { ppid: 99, args: "node honcho-hook.mjs" },
				99: { ppid: 1, args },
			}),
		});
		expect(classify("/opt/homebrew/bin/codex")).toBe("user_interactive");
		expect(classify("/opt/homebrew/bin/codex -c x=y resume")).toBe("user_interactive");
		expect(classify("/opt/homebrew/bin/codex -c x=y exec run")).toBe("automation");
		expect(classify("/opt/homebrew/bin/codex review")).toBe("automation");
		expect(classify("/opt/homebrew/bin/codex --unterminated")).toBe("unknown");
		expect(classify("/opt/homebrew/bin/codex --strict-config exec")).toBe("unknown");
		expect(classify("/opt/homebrew/bin/codex --strict-config=true exec")).toBe("unknown");
	});

	test("missing host process stays unknown", () => {
		expect(classifyEntry({
			host: "codex",
			env: {},
			pid: 100,
			lookupAncestor: ancestry({ 100: { ppid: 1, args: "node hook.mjs" } }),
		})).toBe("unknown");
	});
});

describe("injection stripping", () => {
	test("leading host injection tags discard the entire message", () => {
		expect(stripInjectedUserText("  <system-reminder>generated</system-reminder>\nreal-looking text")).toBeNull();
	});

	test("embedded own-recall blocks are removed", () => {
		expect(stripInjectedUserText("keep <honcho-memory source=\"x\">old</honcho-memory> this <memory-context>cache</memory-context> text"))
			.toBe("keep  this  text");
	});

	test("a message empty after recall removal is discarded", () => {
		expect(stripInjectedUserText("\n<honcho-memory>old</honcho-memory>\n<memory-context>cache</memory-context>\n")).toBeNull();
	});
});

describe("config directory override", () => {
	test("HONCHO_CONFIG_DIR selects its config.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "honcho-config-"));
		const previousDir = process.env.HONCHO_CONFIG_DIR;
		const previousKey = process.env.HONCHO_API_KEY;
		try {
			writeFileSync(join(dir, "config.json"), JSON.stringify({
				enabled: true,
				apiKey: "synthetic-key",
				peerName: "synthetic-user",
				hosts: {
					omp: { workspace: "synthetic-workspace", aiPeer: "synthetic-omp" },
				},
			}));
			process.env.HONCHO_CONFIG_DIR = dir;
			delete process.env.HONCHO_API_KEY;
			const config = resolveConfigForHost("omp", "/tmp");
			expect({
				enabled: config.enabled,
				apiKey: config.apiKey,
				workspace: config.workspace,
				peerName: config.peerName,
				aiPeer: config.aiPeer,
			}).toEqual({
				enabled: true,
				apiKey: "synthetic-key",
				workspace: "synthetic-workspace",
				peerName: "synthetic-user",
				aiPeer: "synthetic-omp",
			});
		} finally {
			if (previousDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
			else process.env.HONCHO_CONFIG_DIR = previousDir;
			if (previousKey === undefined) delete process.env.HONCHO_API_KEY;
			else process.env.HONCHO_API_KEY = previousKey;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("declared hosts default enabled while explicit false is honored", () => {
		const dir = mkdtempSync(join(tmpdir(), "honcho-config-"));
		const previousDir = process.env.HONCHO_CONFIG_DIR;
		const previousKey = process.env.HONCHO_API_KEY;
		try {
			writeFileSync(join(dir, "config.json"), JSON.stringify({
				apiKey: "synthetic-key",
				peerName: "synthetic-user",
				hosts: {
					omp: { enabled: true, workspace: "synthetic-workspace" },
					claude_code: { workspace: "synthetic-workspace" },
					codex: { enabled: false, workspace: "synthetic-workspace" },
				},
			}));
			process.env.HONCHO_CONFIG_DIR = dir;
			delete process.env.HONCHO_API_KEY;
			expect({
				omp: resolveConfigForHost("omp", "/tmp").enabled,
				claude: resolveConfigForHost("claude_code", "/tmp").enabled,
				codex: resolveConfigForHost("codex", "/tmp").enabled,
			}).toEqual({ omp: true, claude: true, codex: false });
			writeFileSync(join(dir, "config.json"), JSON.stringify({
				enabled: false,
				apiKey: "synthetic-key",
				hosts: {
					omp: { enabled: true, workspace: "synthetic-workspace" },
					claude_code: { workspace: "synthetic-workspace" },
				},
			}));
			expect({
				omp: resolveConfigForHost("omp", "/tmp").enabled,
				claude: resolveConfigForHost("claude_code", "/tmp").enabled,
			}).toEqual({ omp: true, claude: false });
		} finally {
			if (previousDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
			else process.env.HONCHO_CONFIG_DIR = previousDir;
			if (previousKey === undefined) delete process.env.HONCHO_API_KEY;
			else process.env.HONCHO_API_KEY = previousKey;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
