/** Synthetic practice-record fixtures for the review tests: native-shaped tool calls and a problem-spec builder. */
import type { AssistantMessage, JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMessage } from "../../src/core/native-messages.ts";

const STAMPS = {
	api: "faux", provider: "test", model: "test-model",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
} as const;

export function call(callId: string, name: string, args: JsonObject, at: number, isError = false): LhMessage[] {
	const assistant: LhMessage & AssistantMessage = { id: `msg_a_${callId}`, role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp: at, ...STAMPS };
	const result: LhMessage & ToolResultMessage = { id: `msg_r_${callId}`, role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "ok" }], details: null, isError, timestamp: at + 1 };
	return [assistant, result];
}

export const pose = (callId: string, target: string[] | undefined, at = 1_000, extra: JsonObject = {}) =>
	call(callId, PRACTICE_PROBLEM_TOOL, { statement: "s", mode: "recall", modelSolution: "m", ...(target ? { target } : {}), ...extra }, at);

export const conclude = (callId: string, outcome: string, rung: string | null, at = 5_000, isError = false, missClass: string | null = null) =>
	call(callId, PRACTICE_CONCLUDE_TOOL, { outcome, verdict: "v", rung, missClass, retest: false }, at, isError);

export const OUTCOMES = ["solved", "solvedWithHints", "movedOn", "surrendered"] as const;

/** One generated problem: what the record holds, plus what a reader must conclude (listed by hand, never derived from the fold). */
export interface ProblemSpec { id: string; tagged: boolean; concluded: boolean; outcome: (typeof OUTCOMES)[number] }

export function recordOf(specs: readonly ProblemSpec[]): LhMessage[] {
	const out: LhMessage[] = [];
	let at = 1_000;
	for (const s of specs) {
		out.push(...pose(`p_${s.id}`, s.tagged ? [`n_${s.id}`] : undefined, at));
		if (s.concluded) out.push(...conclude(`c_${s.id}`, s.outcome, null, at + 10));
		at += 100;
	}
	return out;
}
