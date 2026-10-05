import { classifyOrcaEnvelope, stripInjectedUserText } from "../core/source.js";

// Claude Code 2.1.x submits a pasted multi-line block as `<pasted_content id="…">\n…\n</pasted_content id="…">`.
const WHOLE_PASTE = /^\s*<pasted_content\b[^>]*>\r?\n?([\s\S]*?)\r?\n?<\/pasted_content\b[^>]*>\s*$/;

/**
 * Text a Claude Code/Codex prompt hook may upload as the user's own words, or null.
 * Applies the same Orca envelope rule as OMP capture (complete signature = machine, partial = withheld),
 * to the prompt itself or to the body of a prompt that is exactly one pasted block, then the shared
 * injection stripping.
 */
export function hookUserText(prompt: string): string | null {
	const pasted = WHOLE_PASTE.exec(prompt)?.[1];
	// Unwrap only when the prompt is exactly one block; a lazy match can span several adjacent blocks.
	const body = pasted !== undefined && !/<\/?pasted_content\b/.test(pasted) ? pasted : prompt;
	if (classifyOrcaEnvelope(body) !== "ordinary") return null;
	return stripInjectedUserText(prompt);
}
