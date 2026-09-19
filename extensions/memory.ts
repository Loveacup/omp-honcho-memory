import type { HonchoHandles, HonchoMessage } from "./client.js";

// --- Async save queue: serializes Honcho uploads so multiple agent_end
// events do not issue concurrent addMessages calls. Boundaries such as
// session switch / compact / shutdown await flushPending() to ensure
// all queued uploads complete before the session state changes.
let pendingSave: Promise<void> = Promise.resolve();

const enqueue = (fn: () => Promise<void>): Promise<void> => {
	pendingSave = pendingSave.then(fn, () => fn());
	return pendingSave;
};

export const flushPending = (): Promise<void> => pendingSave;

export function queueMessageBatch(
	handles: HonchoHandles,
	batch: HonchoMessage[],
): Promise<void> {
	if (batch.length === 0) return Promise.resolve();
	return enqueue(async () => {
		await handles.session.addMessages(batch);
	});
}

export interface MemoryContextBlock {
	userPeerName: string;
	userRepresentation: string;
	userPeerCard: string[] | null;
	aiPeerName: string;
	aiRepresentation: string;
	aiPeerCard: string[] | null;
	summary: string | null;
}

export interface PromptContextBlock {
	representation: string;
	peerCard: string[] | null;
}

export interface ContextCache {
	block: PromptContextBlock | null;
	queriedAt: number;
	messageCount: number;
}

export interface PromptContextOptions {
	searchQuery: string;
	maxConclusions?: number;
	searchTopK?: number;
	searchMaxDistance?: number;
}

function clampText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function parseRepresentation(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim() : "";
}

function parseSessionSummary(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim() : "";
}
export async function hydrateMemoryContext(handles: HonchoHandles): Promise<MemoryContextBlock> {

	const [userCtx, aiCtx, summaries] = await Promise.allSettled([
		handles.userPeer.context({ maxConclusions: 12, includeMostFrequent: true }),
		handles.aiPeer.context({ maxConclusions: 8, includeMostFrequent: true }),
		handles.session.summaries(),
	]);

	const userRepresentation =
		userCtx.status === "fulfilled" ? parseRepresentation(userCtx.value.representation) : "";
	const userPeerCard = userCtx.status === "fulfilled" ? userCtx.value.peerCard : null;
	const aiRepresentation =
		aiCtx.status === "fulfilled" ? parseRepresentation(aiCtx.value.representation) : "";
	const aiPeerCard = aiCtx.status === "fulfilled" ? aiCtx.value.peerCard : null;
	const summary =
		summaries.status === "fulfilled"
			? parseSessionSummary(summaries.value.shortSummary) ||
			  parseSessionSummary(summaries.value.longSummary)
			: null;

	return {
		userPeerName: handles.userPeerName,
		userRepresentation,
		userPeerCard,
		aiPeerName: handles.aiPeerName,
		aiRepresentation,
		aiPeerCard,
		summary,
	};
}

export async function refreshPromptContext(
	handles: HonchoHandles,
	query: string,
	observationMode: "unified" | "directional" = "unified",
): Promise<PromptContextBlock | null> {
	if (!query.trim()) return null;

	const searchQuery = query;

	const contextPeer = observationMode === "directional" ? handles.aiPeer : handles.userPeer;
	const target = observationMode === "directional" ? handles.userPeer : undefined;

	const result = await contextPeer.context({
		...(target ? { target } : {}),
		searchQuery,
		searchTopK: 5,
		searchMaxDistance: 0.7,
		maxConclusions: 15,
		includeMostFrequent: true,
	});

	const representation = parseRepresentation(result.representation);
	if (!representation && !result.peerCard?.length) return null;

	return {
		representation,
		peerCard: result.peerCard,
	};
}
/**
 * Extract meaningful topics from a prompt for semantic search.
 * Returns terms that are high-signal for conclusion matching.
 * Based on the official Honcho Claude Code plugin's approach.
 */
export function extractTopics(prompt: string): string[] {
	const topics: string[] = [];

	// File paths (high signal)
	const filePaths = prompt.match(/[\w\-\/\.]+\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|sql)/gi) || [];
	topics.push(...filePaths.slice(0, 5));

	// Quoted strings (explicit references)
	const quoted = prompt.match(/"([^"]+)"/g)?.map((q) => q.slice(1, -1)) || [];
	topics.push(...quoted.slice(0, 3));

	// Technical terms (English and common Chinese-English mix)
	const techTerms =
		prompt.match(
			/\b(react|vue|svelte|angular|elysia|express|fastapi|django|flask|postgres|redis|docker|kubernetes|bun|node|deno|typescript|python|rust|go|graphql|rest|api|auth|oauth|jwt|stripe|webhook|honcho|mcp|claude|cursor|sentry|github|npm|release|publish|deploy|ci|test|build|lint|format)\b/gi,
		) || [];
	const releaseTerms = prompt.match(/(发版|发布|上线|部署|测试|构建|发布流程|npm|版本|新版)/gi) || [];
	topics.push(...[...new Set(techTerms.map((t) => t.toLowerCase()))].slice(0, 5));
	topics.push(...[...new Set(releaseTerms)].slice(0, 5));

	// Error / status patterns
	const errors = prompt.match(/error[:\s]+[\w\s]+|failed[:\s]+[\w\s]+|exception[:\s]+[\w\s]+|失败|错误|报错/gi) || [];
	topics.push(...errors.slice(0, 2));

	if (topics.length > 0) {
		return [...new Set(topics)];
	}

	// Fallback: meaningful words >3 chars minus stopwords
	const stopwords = new Set([
		"the",
		"and",
		"for",
		"that",
		"this",
		"with",
		"from",
		"have",
		"are",
		"was",
		"were",
		"been",
		"being",
		"has",
		"had",
		"does",
		"did",
		"will",
		"would",
		"could",
		"should",
		"can",
		"may",
		"might",
		"must",
		"shall",
		"need",
		"want",
		"like",
		"just",
		"also",
		"more",
		"some",
		"what",
		"when",
		"where",
		"which",
		"who",
		"how",
		"why",
		"all",
		"each",
		"every",
		"both",
		"few",
		"most",
		"other",
		"into",
		"over",
		"such",
		"only",
		"same",
		"than",
		"very",
		"your",
		"make",
		"take",
		"come",
		"give",
		"look",
		"think",
		"know",
		"我们",
		"应该",
		"可以",
		"需要",
		"这个",
		"那个",
		"什么",
		"怎么",
		"为什么",
		"因为",
		"所以",
		"但是",
		"然后",
	]);
	const words = prompt.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
	return [...new Set(words.filter((w) => !stopwords.has(w)))].slice(0, 10);
}
/**
 * Parse Honcho's representation string into clean observation lines.
 * Honcho wraps output in `## Explicit Observations` / `Key facts:` sections
 * with timestamps. We strip those and return only the core text.
 */
export function parseObservationLines(raw: string): string[] {
	if (!raw.trim()) return [];
	const lines: string[] = [];
	let inObservations = false;
	let seenHonchoFormat = false;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Skip Honcho section headers
		if (trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
			seenHonchoFormat = true;
			inObservations = trimmed.toLowerCase().includes("observation");
			continue;
		}
		if (trimmed.startsWith("Key facts:")) break;
		// Strip timestamp prefix: [YYYY-MM-DD HH:MM:SS]
		const cleaned = trimmed.replace(/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\]\s*/, "");
		if (cleaned) lines.push(cleaned);
	}
	// If no Honcho structured format detected, treat the entire text as observations
	if (!seenHonchoFormat) {
		return raw.split("\n").map((l) => l.trim()).filter(Boolean);
	}
	return lines;
}

export function formatPeerCardCompact(card: string[] | null): string {
	if (!card || card.length === 0) return "";
	// Include all entries; strip role prefixes from ones that have them.
	const cleaned = card.map((c) => {
		// Strip common Honcho prefixes: IDENTITY:, ATTRIBUTE:, INSTRUCTION:, ROLE:, RELATIONSHIP:
		return c.replace(/^(?:IDENTITY|ATTRIBUTE|INSTRUCTION|ROLE|RELATIONSHIP):\s*/, "");
	});
	return cleaned.join(" · ");
}

/**
 * Format a single peer's context as a structured block with `###` heading.
 * Observations become bullet points; peer card is the first bullet.
 * The redundant `peerName ` prefix is stripped from observations.
 */
function formatPeerSection(
	heading: string,
	peerName: string,
	representation: string,
	peerCard: string[] | null,
	maxObservations: number = 5,
): string | null {
	const observations = parseObservationLines(representation);
	const card = formatPeerCardCompact(peerCard);
	if (observations.length === 0 && !card) return null;

	const lines: string[] = [];
	lines.push(`### ${heading} (${peerName})`);
	if (card) {
		lines.push(`- ${card}`);
	}
	// Strip redundant "peerName " prefix from each observation
	const peerPrefix = `${peerName} `;
	for (const obs of observations.slice(0, maxObservations)) {
		const cleaned = obs.startsWith(peerPrefix) ? obs.slice(peerPrefix.length) : obs;
		lines.push(`- ${cleaned}`);
	}
	return lines.join("\n");
}

export function compileMemoryContext(
	block: MemoryContextBlock,
	promptContext: PromptContextBlock | null,
): string | null {
	const sections: string[] = [];

	const userSection = formatPeerSection(
		"Developer", block.userPeerName,
		block.userRepresentation, block.userPeerCard,
	);
	if (userSection) sections.push(userSection);

	const aiSection = formatPeerSection(
		"AI", block.aiPeerName,
		block.aiRepresentation, block.aiPeerCard, 4,
	);
	if (aiSection) sections.push(aiSection);

	if (block.summary) {
		sections.push(`### Recent\n- ${block.summary}`);
	}

	if (promptContext) {
		const promptSection = formatPeerSection(
			"Relevant", "search",
			promptContext.representation, promptContext.peerCard, 3,
		);
		if (promptSection) sections.push(promptSection);
	}

	if (sections.length === 0) return null;

	return [
		"## Honcho Memory",
		"Use this as persistent developer and project memory. Prefer it over guessing, but only mention it when relevant to the current task.",
		"",
		sections.join("\n\n"),
	].join("\n");
}

export function formatContinuityContext(
	handles: HonchoHandles,
	lastInjectedContext: string | null,
	recentConclusions: string[],
): string | null {
	const lines: string[] = [];

	lines.push("## Honcho Continuity");
	lines.push(`Workspace: ${handles.workspaceId}`);
	lines.push(`Session key: ${handles.sessionId}`);
	lines.push(`User peer: ${handles.userPeerId}`);
	lines.push(`AI peer: ${handles.aiPeerId}`);

	if (lastInjectedContext) {
		lines.push("");
		lines.push("Last injected memory:");
		lines.push(lastInjectedContext);
	}

	if (recentConclusions.length > 0) {
		lines.push("");
		lines.push("Recent durable conclusions:");
		for (const conclusion of recentConclusions) {
			lines.push(`- ${conclusion}`);
		}
	}

	return lines.join("\n");
}

export async function saveUserMessage(
	handles: HonchoHandles,
	content: string,
	metadata: Record<string, unknown> = {},
	createdAt?: string,
): Promise<void> {
	const trimmed = clampText(content.trim(), 25_000);
	if (!trimmed) return;
	await handles.session.addMessages([
		handles.userPeer.message(trimmed, { metadata, createdAt }),
	]);
}
export async function saveAssistantMessage(
	handles: HonchoHandles,
	content: string,
	metadata: Record<string, unknown> = {},
	createdAt?: string,
): Promise<void> {
	const trimmed = clampText(content.trim(), 25_000);
	if (!trimmed) return;
	await handles.session.addMessages([
		handles.aiPeer.message(trimmed, { metadata, createdAt }),
	]);
}

export async function saveToolSummary(
	handles: HonchoHandles,
	summary: string,
	metadata: Record<string, unknown> = {},
	createdAt?: string,
): Promise<void> {
	const trimmed = clampText(`[Tool] ${summary.trim()}`, 25_000);
	if (!trimmed) return;
	await handles.session.addMessages([
		handles.aiPeer.message(trimmed, { metadata, createdAt }),
	]);
}

export async function saveUserConclusion(
	handles: HonchoHandles,
	content: string,
): Promise<{ saved: boolean; error?: string }> {
	const trimmed = clampText(content.trim(), 25_000);
	if (!trimmed) return { saved: false, error: "Empty content." };
	await handles.aiPeer.conclusionsOf(handles.userPeer).create({
		content: trimmed,
		sessionId: handles.session.id,
	});
	return { saved: true };
}


