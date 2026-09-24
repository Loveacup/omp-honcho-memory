import { execFileSync } from "node:child_process";

export type HonchoHost = "omp" | "claude_code" | "codex";
export type EntryClass = "user_interactive" | "automation" | "unknown";

export interface AncestorProcess {
	ppid: number;
	args: string;
}

export type AncestorLookup = (pid: number) => AncestorProcess | null;

export interface ClassificationInput {
	host: HonchoHost;
	env?: NodeJS.ProcessEnv;
	pid?: number;
	payload?: Record<string, unknown>;
	omp?: {
		mode?: "tui" | "rpc" | "json" | "print" | string;
		hasUI?: boolean;
	};
	lookupAncestor?: AncestorLookup;
}

const LEADING_INJECTION_TAGS = [
	"task-notification",
	"local-command-stdout",
	"command-name",
	"command-message",
	"system-reminder",
	"bash-stdout",
	"bash-stderr",
	"bash-input",
	"environment_context",
	"turn_aborted",
	"user_instructions",
	"apps_instructions",
	"plugins_instructions",
	"skills_instructions",
	"collaboration_mode",
] as const;

const LEADING_INJECTION = new RegExp(
	`^\\s*<(?:${LEADING_INJECTION_TAGS.join("|")})(?:\\s|>|/)`,
	"i",
);
const OWN_RECALL_BLOCK = /<(honcho-memory|memory-context)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

function automationMarker(env: NodeJS.ProcessEnv): boolean {
	const value = env.HONCHO_AUTOMATION;
	return typeof value === "string" && value.length > 0 && value !== "0";
}

function defaultAncestorLookup(pid: number): AncestorProcess | null {
	try {
		const output = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1_000,
		}).trim();
		const match = output.match(/^(\d+)\s+([\s\S]+)$/);
		if (!match) return null;
		return { ppid: Number(match[1]), args: match[2] };
	} catch {
		return null;
	}
}

function hostCommand(args: string): "claude" | "codex" | null {
	const command = args.trim().split(/\s+/, 1)[0] ?? "";
	const executable = command.split("/").pop()?.toLowerCase() ?? "";
	if (executable === "claude" || executable.startsWith("claude-")) return "claude";
	if (executable === "codex" || executable.startsWith("codex-")) return "codex";
	return null;
}

function isClaudeAutomation(args: string): boolean {
	return /(?:^|\s)(?:-p|--print)(?=\s|$)|(?:^|\s)--(?:output|input)-format(?:=|\s)/.test(args);
}

function tokenizeProcessArgs(args: string): string[] | null {
	const tokens: string[] = [];
	let token = "";
	let started = false;
	let quote: "'" | "\"" | null = null;
	let escaped = false;
	for (const character of args.trim()) {
		if (escaped) {
			token += character;
			started = true;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = null;
			else token += character;
			started = true;
			continue;
		}
		if (character === "'" || character === "\"") {
			quote = character;
			started = true;
		} else if (/\s/.test(character)) {
			if (started) {
				tokens.push(token);
				token = "";
				started = false;
			}
		} else {
			token += character;
			started = true;
		}
	}
	if (escaped || quote) return null;
	if (started) tokens.push(token);
	return tokens;
}

const CODEX_BOOLEAN_OPTIONS: Record<string, true> = {
	"--oss": true,
	"--full-auto": true,
	"--search": true,
	"--no-alt-screen": true,
	"--dangerously-bypass-approvals-and-sandbox": true,
};
const CODEX_VALUE_OPTIONS: Record<string, true> = {
	"-c": true,
	"--config": true,
	"-m": true,
	"--model": true,
	"-p": true,
	"--profile": true,
	"-s": true,
	"--sandbox": true,
	"-a": true,
	"--ask-for-approval": true,
	"-C": true,
	"--cd": true,
	"-i": true,
	"--image": true,
	"--add-dir": true,
	"--oss-provider": true,
	"--color": true,
	"--enable": true,
	"--disable": true,
};

function classifyCodexArgs(args: string): EntryClass {
	const tokens = tokenizeProcessArgs(args);
	if (!tokens || tokens.length === 0) return "unknown";
	let index = 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === "--") {
			index++;
			break;
		}
		if (!token.startsWith("-") || token === "-") break;
		if (token === "-h" || token === "--help" || token === "-V" || token === "--version") return "automation";
		if (CODEX_BOOLEAN_OPTIONS[token] || /^-[cCmpsai].+/.test(token)) {
			index++;
			continue;
		}
		const equalsIndex = token.indexOf("=");
		if (equalsIndex > 0) {
			const option = token.slice(0, equalsIndex);
			if (!CODEX_VALUE_OPTIONS[option] || equalsIndex === token.length - 1) return "unknown";
			index++;
			continue;
		}
		if (CODEX_VALUE_OPTIONS[token]) {
			if (index + 1 >= tokens.length || tokens[index + 1].startsWith("-")) return "unknown";
			index += 2;
			continue;
		}
		return "unknown";
	}
	if (index === tokens.length) return "user_interactive";
	const subcommand = tokens[index];
	if (subcommand === "resume" || subcommand === "fork") return "user_interactive";
	return "automation";
}

export function classifyEntry(input: ClassificationInput): EntryClass {
	const env = input.env ?? process.env;
	if (automationMarker(env)) return "automation";

	if (input.host === "omp") {
		if (input.omp?.mode !== undefined && input.omp.mode !== "tui") return "automation";
		if (input.omp?.hasUI === false) return "automation";
		return input.omp?.mode === "tui" ? "user_interactive" : "unknown";
	}

	if (input.host === "claude_code") {
		if (typeof input.payload?.agent_id === "string" && input.payload.agent_id.length > 0) {
			return "automation";
		}
		const entrypoint = env.CLAUDE_CODE_ENTRYPOINT;
		if (typeof entrypoint === "string" && entrypoint.toLowerCase().startsWith("sdk")) {
			return "automation";
		}
	}

	const lookup = input.lookupAncestor ?? defaultAncestorLookup;
	const deadline = Date.now() + 2_000;
	let pid = input.pid ?? process.ppid;
	for (let depth = 0; depth < 6 && pid > 0; depth++) {
		if (Date.now() >= deadline) return "unknown";
		const ancestor = lookup(pid);
		if (Date.now() >= deadline || !ancestor) return "unknown";
		const command = hostCommand(ancestor.args);
		if (command === "claude" && input.host === "claude_code") {
			return isClaudeAutomation(ancestor.args) ? "automation" : "user_interactive";
		}
		if (command === "codex" && input.host === "codex") {
			return classifyCodexArgs(ancestor.args);
		}
		pid = ancestor.ppid;
	}
	return "unknown";
}

export function stripInjectedUserText(text: string): string | null {
	if (LEADING_INJECTION.test(text)) return null;
	const stripped = text.replace(OWN_RECALL_BLOCK, "").trim();
	return stripped.length > 0 ? stripped : null;
}
