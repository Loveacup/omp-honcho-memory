export function extractTextFromMessage(message: { role: string; content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter(
				(part): part is { type: "text"; text: string } =>
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

export function extractToolNameFromMessage(message: { role: string; content?: unknown }): string | null {
	if (!Array.isArray(message.content)) return null;
	const toolCalls = message.content.filter(
		(part): part is { type: "toolCall"; name: string; arguments: unknown } =>
			typeof part === "object" &&
			part !== null &&
			"type" in part &&
			part.type === "toolCall" &&
			"name" in part &&
			typeof part.name === "string",
	);
	if (toolCalls.length === 0) return null;
	return toolCalls.map((tc) => tc.name).join(", ");
}

export function summarizeToolResult(message: { role: string; content?: unknown }): string | null {
	if (message.role !== "tool" || typeof message.content !== "string") return null;
	const content = message.content.trim();
	if (!content) return null;
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) return null;
	const first = lines[0].trim();
	const summary = first.length > 120 ? `${first.slice(0, 120)}...` : first;
	return summary;
}

export interface MessagePair {
	role: "user" | "assistant";
	content: string;
}

/**
 * Check if a message content array contains tool_call entries.
 * Used to filter out intermediate tool-execution assistant turns.
 */
function hasToolCalls(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some(
		(part): part is { type: string } =>
			typeof part === "object" &&
			part !== null &&
			"type" in part &&
			part.type === "toolCall",
	);
}
export function collectMessagePairs(
	messages: Array<{ role: string; content?: unknown }> | undefined,
): MessagePair[] {
	const pairs: MessagePair[] = [];
	if (!Array.isArray(messages)) return pairs;
	for (const message of messages) {
		const text = extractTextFromMessage(message);
		if (!text) continue;
		if (message.role === "user") {
			pairs.push({ role: "user", content: text });
		} else if (message.role === "assistant") {
			// Skip assistant messages that carry tool calls — these are
			// intermediate tool-execution turns, not actual conversation.
			if (hasToolCalls(message.content)) continue;
			pairs.push({ role: "assistant", content: text });
		}
	}
	return pairs;
}

export function collectToolSummary(
	messages: Array<{ role: string; content?: unknown }> | undefined,
): string | null {
	if (!Array.isArray(messages)) return null;

	const summaries: string[] = [];
	let lastAssistantToolNames: string | null = null;

	for (const message of messages) {
		if (message.role === "assistant") {
			lastAssistantToolNames = extractToolNameFromMessage(message);
			continue;
		}
		if (message.role === "tool") {
			const resultSummary = summarizeToolResult(message);
			if (resultSummary) {
				const toolNames = lastAssistantToolNames || "tool";
				summaries.push(`${toolNames}: ${resultSummary}`);
			}
			lastAssistantToolNames = null;
		}
	}

	if (summaries.length === 0) return null;
	return summaries.join("; ");
}

const DURABLE_PATTERNS = [
	/\b(i\s+(?:like|prefer|want|need|hate|dislike|love)|we\s+should\s+(?:always|never)|(?:always|never)\s+(?:use|do|set)|my\s+(?:preferred|favorite)|\bprefer\b|\bpreference\b)/i,
	/(我(?:喜欢|偏好|想要|需要|讨厌|不喜欢|爱)|我们(?:应该|不应该|总是|永远|绝不|要|不要)|(?:总是|永远|绝不|不要)\s*(?:使用|做|设置)|我的(?:偏好|最爱|首选)|偏好|倾向|习惯)/,
];

export function extractDurableConclusion(content: string): string | null {
	const trimmed = content.trim();
	if (!trimmed) return null;
	if (!DURABLE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
		return null;
	}
	return trimmed;
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function truncateToTokens(text: string, maxTokens: number): string {
	if (maxTokens <= 0) return text;
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars - 3)}...`;
}

export function maybeTruncateContent(
	content: string,
	config: { maxTokens?: number; summarize?: boolean },
): string {
	if (!config.maxTokens) return content;
	if (config.summarize && estimateTokens(content) > config.maxTokens) {
		// Best-effort summarization: keep first paragraph, indicate truncation.
		const firstParagraph = content.split("\n\n")[0] ?? "";
		const truncated = truncateToTokens(firstParagraph, Math.max(1, config.maxTokens - 5));
		return `${truncated}\n\n[Content truncated; original was ${estimateTokens(content)} tokens]`;
	}
	return truncateToTokens(content, config.maxTokens);
}
