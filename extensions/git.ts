import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitState {
	branch: string;
	commit: string;
	commitMessage: string;
	isDirty: boolean;
	dirtyFiles: string[];
	timestamp: string;
}

export type FeatureType = "feature" | "fix" | "refactor" | "docs" | "test" | "chore" | "unknown";

export interface GitFeatureContext {
	type: FeatureType;
	description: string;
	keywords: string[];
	areas: string[];
	confidence: "low" | "medium" | "high";
}

export interface GitStateChange {
	type: "branch" | "commit" | "dirty" | "initial";
	description: string;
	from?: string;
	to?: string;
}

export function isGitRepo(cwd: string): boolean {
	return existsSync(join(cwd, ".git"));
}

function gitCommand(cwd: string, args: string): string | null {
	try {
		return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}
export function captureGitState(cwd: string): GitState | null {
	if (!isGitRepo(cwd)) return null;

	const branch = gitCommand(cwd, "rev-parse --abbrev-ref HEAD") || "unknown";
	const commit = gitCommand(cwd, "rev-parse --short HEAD") || "unknown";
	const commitMessage = gitCommand(cwd, "log -1 --format=%s") || "";

	let statusOutput = "";
	try {
		statusOutput = execSync("git status --porcelain", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
	} catch {
		statusOutput = "";
	}
	const isDirty = statusOutput.trim().length > 0;
	const dirtyFiles = isDirty
		? statusOutput
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => line.slice(3).trim())
				.slice(0, 20)
		: [];

	return {
		branch,
		commit,
		commitMessage,
		isDirty,
		dirtyFiles,
		timestamp: new Date().toISOString(),
	};
}

export function getRecentCommits(cwd: string, count = 5): string[] {
	if (!isGitRepo(cwd)) return [];
	const output = gitCommand(cwd, `log -${count} --oneline`);
	if (!output) return [];
	return output.split("\n").filter((line) => line.trim());
}

export function detectGitChanges(previous: GitState | null, current: GitState): GitStateChange[] {
	const changes: GitStateChange[] = [];

	if (!previous) {
		changes.push({
			type: "initial",
			description: `Initial git state on ${current.branch} (${current.commit})`,
		});
		return changes;
	}

	if (previous.branch !== current.branch) {
		changes.push({
			type: "branch",
			description: `Branch changed from ${previous.branch} to ${current.branch}`,
			from: previous.branch,
			to: current.branch,
		});
	}

	if (previous.commit !== current.commit) {
		changes.push({
			type: "commit",
			description: `HEAD moved from ${previous.commit} to ${current.commit}: ${current.commitMessage}`,
			from: previous.commit,
			to: current.commit,
		});
	}

	const previousDirty = new Set(previous.dirtyFiles);
	const currentDirty = new Set(current.dirtyFiles);
	const added = current.dirtyFiles.filter((f) => !previousDirty.has(f));
	const removed = previous.dirtyFiles.filter((f) => !currentDirty.has(f));

	if (added.length > 0 || removed.length > 0 || (current.isDirty && !previous.isDirty)) {
		changes.push({
			type: "dirty",
			description: `Working tree changed (${added.length} added, ${removed.length} removed since last check)`,
		});
	}

	return changes;
}

const BRANCH_TYPE_PATTERNS: Array<{ pattern: RegExp; type: FeatureType }> = [
	{ pattern: /^(feat|feature)[/-]/i, type: "feature" },
	{ pattern: /^(fix|bugfix|hotfix)[/-]/i, type: "fix" },
	{ pattern: /^(refactor|refactoring)[/-]/i, type: "refactor" },
	{ pattern: /^(docs|documentation)[/-]/i, type: "docs" },
	{ pattern: /^(test|tests|testing)[/-]/i, type: "test" },
	{ pattern: /^(chore|build|ci)[/-]/i, type: "chore" },
];

const COMMIT_TYPE_PATTERNS: Array<{ pattern: RegExp; type: FeatureType }> = [
	{ pattern: /^feat(\(.+\))?:/i, type: "feature" },
	{ pattern: /^fix(\(.+\))?:/i, type: "fix" },
	{ pattern: /^refactor(\(.+\))?:/i, type: "refactor" },
	{ pattern: /^docs(\(.+\))?:/i, type: "docs" },
	{ pattern: /^test(\(.+\))?:/i, type: "test" },
	{ pattern: /^chore(\(.+\))?:/i, type: "chore" },
	{ pattern: /^(build|ci)(\(.+\))?:/i, type: "chore" },
];

const PATH_AREA_PATTERNS: Array<{ pattern: RegExp; area: string }> = [
	{ pattern: /\/(api|routes|endpoints)\//i, area: "api" },
	{ pattern: /\/(auth|authentication|login)\//i, area: "auth" },
	{ pattern: /\/(ui|components|views|pages)\//i, area: "ui" },
	{ pattern: /\/(hooks)\//i, area: "hooks" },
	{ pattern: /\/(config|settings)\//i, area: "config" },
	{ pattern: /\/(test|tests|__tests__|spec)\//i, area: "testing" },
	{ pattern: /\/(docs|documentation)\//i, area: "docs" },
	{ pattern: /\/(utils|helpers|lib)\//i, area: "utils" },
	{ pattern: /\/(cache|storage)\//i, area: "cache" },
	{ pattern: /\/(cli|commands)\//i, area: "cli" },
	{ pattern: /\/(skills)\//i, area: "skills" },
	{ pattern: /\.(md|mdx)$/i, area: "docs" },
	{ pattern: /\.(test|spec)\.(ts|js|tsx|jsx)$/i, area: "testing" },
];

function extractKeywords(text: string): string[] {
	const cleaned = text
		.replace(/^(feat|fix|refactor|docs|test|chore|feature|bugfix|hotfix)[/:-]/i, "")
		.replace(/(\(.+\))?:/g, " ");
	const words = cleaned
		.split(/[-_/\s]+/)
		.map((w) => w.toLowerCase().trim())
		.filter((w) => w.length > 2 && w.length < 20)
		.filter((w) => !["the", "and", "for", "with", "add", "update", "fix"].includes(w));
	return [...new Set(words)].slice(0, 10);
}

function parseBranchName(branch: string): { type: FeatureType; description: string } {
	for (const { pattern, type } of BRANCH_TYPE_PATTERNS) {
		if (pattern.test(branch)) {
			const description = branch.replace(pattern, "").replace(/[-_]/g, " ").trim();
			return { type, description };
		}
	}
	const description = branch.replace(/^(main|master|develop|dev)$/i, "").replace(/[-_]/g, " ").trim();
	return { type: "unknown", description: description || branch };
}

function inferTypeFromCommits(commits: string[]): FeatureType | null {
	const typeCounts: Record<FeatureType, number> = {
		feature: 0,
		fix: 0,
		refactor: 0,
		docs: 0,
		test: 0,
		chore: 0,
		unknown: 0,
	};
	for (const commit of commits) {
		const message = commit.replace(/^[a-f0-9]+\s+/i, "");
		for (const { pattern, type } of COMMIT_TYPE_PATTERNS) {
			if (pattern.test(message)) {
				typeCounts[type]++;
				break;
			}
		}
	}
	let maxType: FeatureType | null = null;
	let maxCount = 0;
	for (const [type, count] of Object.entries(typeCounts)) {
		if (type !== "unknown" && count > maxCount) {
			maxCount = count;
			maxType = type as FeatureType;
		}
	}
	return maxCount > 0 ? maxType : null;
}

function inferAreasFromFiles(files: string[]): string[] {
	const areas = new Set<string>();
	for (const file of files) {
		for (const { pattern, area } of PATH_AREA_PATTERNS) {
			if (pattern.test(file)) areas.add(area);
		}
	}
	return [...areas].slice(0, 5);
}

export function inferFeatureContext(gitState: GitState, recentCommits: string[] = []): GitFeatureContext {
	const { type: branchType, description: branchDesc } = parseBranchName(gitState.branch);
	const commitType = inferTypeFromCommits(recentCommits);
	const inferredType = branchType !== "unknown" ? branchType : (commitType || "unknown");

	const branchKeywords = extractKeywords(gitState.branch);
	const commitKeywords = recentCommits.flatMap((c) => extractKeywords(c));
	const allKeywords = [...new Set([...branchKeywords, ...commitKeywords])].slice(0, 10);

	const allFiles = [...gitState.dirtyFiles];
	for (const commit of recentCommits) {
		const fileMatch = commit.match(/\b[\w/-]+\.(ts|js|tsx|jsx|json|md)\b/g);
		if (fileMatch) allFiles.push(...fileMatch);
	}
	const areas = inferAreasFromFiles(allFiles);

	let description = branchDesc;
	if (!description && gitState.commitMessage) {
		description = gitState.commitMessage
			.replace(/^(feat|fix|refactor|docs|test|chore)(\(.+\))?:\s*/i, "")
			.slice(0, 100);
	}

	let confidence: GitFeatureContext["confidence"] = "low";
	if (branchType !== "unknown" && allKeywords.length > 2) {
		confidence = "high";
	} else if (commitType || allKeywords.length > 0) {
		confidence = "medium";
	}

	return {
		type: inferredType,
		description: description || "general development",
		keywords: allKeywords,
		areas,
		confidence,
	};
}

export function formatFeatureContext(context: GitFeatureContext): string {
	const parts: string[] = [];
	parts.push(`Type: ${context.type}`);
	parts.push(`Description: ${context.description}`);
	if (context.keywords.length > 0) parts.push(`Keywords: ${context.keywords.join(", ")}`);
	if (context.areas.length > 0) parts.push(`Areas: ${context.areas.join(", ")}`);
	parts.push(`Confidence: ${context.confidence}`);
	return parts.join("\n");
}
