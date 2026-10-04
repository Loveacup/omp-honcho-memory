import { describe, expect, test } from "bun:test";
import { allowsUserConclusionFromBranch } from "../extensions/tools.js";

function userMessage(content: string): { type: string; message: { role: string; content: string } } {
	return { type: "message", message: { role: "user", content } };
}

describe("conclusion-write source gate", () => {
	test("machine and ambiguous Orca turns cannot create user conclusions", () => {
		const dispatch = [
			"You are working inside Orca, a multi-agent IDE. You are a dispatched worker.",
			"Your coordinator's terminal handle is: synthetic-terminal-17",
			"Your task ID is: synthetic-task-17",
		].join("\n");
		const ambiguousDispatch = [
			"You are working inside Orca, a multi-agent IDE. You are a dispatched worker.",
			"Your task ID is: synthetic-task-18",
		].join("\n");
		const continuation = [
			"Continue work from the prior Orca session using the context below.",
			"Original agent: worker-17",
			"Prior read-only provider context follows.",
			"Prior transcript: `sessions/worker-17.jsonl`",
		].join("\n");
		expect(allowsUserConclusionFromBranch([])).toBe(false);

		expect(allowsUserConclusionFromBranch([userMessage(dispatch)])).toBe(false);
		expect(allowsUserConclusionFromBranch([userMessage(ambiguousDispatch)])).toBe(false);
		expect(allowsUserConclusionFromBranch([userMessage(continuation)])).toBe(false);
	});

	test("a following human turn and ordinary template discussion remain eligible", () => {
		const dispatchOpenerDiscussion = [
			"You are working inside Orca, a multi-agent IDE. You are a dispatched worker.",
			"I am quoting that opener to discuss its wording.",
		].join("\n");
		const branch = [
			userMessage("You are working inside Orca, a multi-agent IDE. You are a dispatched worker.\nYour coordinator's terminal handle is: synthetic-terminal-17\nYour task ID is: synthetic-task-17"),
			{ type: "message", message: { role: "assistant", content: "What would you like to remember?" } },
			userMessage("Please remember that I prefer concise summaries."),
		];

		expect(allowsUserConclusionFromBranch([userMessage(dispatchOpenerDiscussion)])).toBe(true);
		expect(allowsUserConclusionFromBranch(branch)).toBe(true);
		expect(allowsUserConclusionFromBranch([{ type: "message", message: { role: "assistant", content: "not a user turn" } }])).toBe(false);
	});
});
