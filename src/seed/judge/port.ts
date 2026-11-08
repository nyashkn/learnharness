import { createHash } from "node:crypto";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AllowEgress } from "../types";

/** K-D6 cap. K1 owns clipSnippet; the judge re-checks because it is the last stop before the wire. */
export const MAX_SNIPPET_CHARS = 300;

/** Wire format copied from research/refs/jev-mcp (System One): Noul, Choice, 3-level Score. */
export type Question =
	| { id: string; kind: "noul"; instructions: string }
	| { id: string; kind: "choice"; instructions: string; options: Readonly<Record<string, string | null>> }
	| { id: string; kind: "score"; instructions: string; levels: readonly [string, string, string] };

export type Answer =
	| { kind: "noul"; probability: number }
	| { kind: "choice"; choice: string; probabilities: Record<string, number> }
	| { kind: "score"; score: number };

export interface JudgeRequest {
	/** Feeds the egress guard only. Never serialized. */
	projects: readonly (string | null)[];
	counts: Readonly<Record<string, number>>;
	snippets: readonly string[];
	questions: readonly Question[];
}

export type NoDecisionReason = "egress-denied" | "no-token" | "transport" | "invalid-answer" | "snippet-too-long";

export type JudgeOutcome =
	| { kind: "answered"; answers: Record<string, Answer>; model: string; cached: boolean }
	| { kind: "no-decision"; reason: NoDecisionReason };

export interface JudgePort {
	ask(req: JudgeRequest): Promise<JudgeOutcome>;
}

/** Shape of the judgment_cache table. */
export interface JudgmentCache {
	get(requestSha: string): Promise<{ responseJson: string } | null>;
	put(requestSha: string, model: string, responseJson: string, at: string): Promise<void>;
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

export function requireGuard(allowEgress: unknown): asserts allowEgress is AllowEgress {
	if (typeof allowEgress !== "function") throw new TypeError("judge adapter requires an allowEgress guard");
}

/** The only state that reaches the wire: counts and redacted snippets. */
export const buildState = (req: JudgeRequest) => ({ counts: req.counts, snippets: req.snippets });

export function wireQuestions(questions: readonly Question[]): Record<string, unknown> {
	const wire: Record<string, unknown> = {};
	for (const q of questions) {
		wire[q.id] =
			q.kind === "noul"
				? { type: "noul", instructions: q.instructions }
				: q.kind === "choice"
					? { type: "choice", instructions: q.instructions, criteria: q.options }
					: { type: "score", instructions: q.instructions, criteria: q.levels };
	}
	return wire;
}

// The ref validates Choice sums with a rounding tolerance; answers are reported to 2 decimals.
const SUM_TOLERANCE = 0.02;
const probability = Type.Number({ minimum: 0, maximum: 1 });

function answerSchema(q: Question): TSchema {
	if (q.kind === "noul") return Type.Object({ noul: probability });
	if (q.kind === "score") return Type.Object({ score: Type.Number({ minimum: 0, maximum: 2 }) });
	const ids = Object.keys(q.options);
	if (ids.length < 2) throw new RangeError(`choice question ${q.id} needs at least two options`);
	return Type.Object({
		choice: Type.Union(ids.map((id) => Type.Literal(id))),
		probabilities: Type.Object(Object.fromEntries(ids.map((id) => [id, probability])), { additionalProperties: false }),
	});
}

/** One schema per request: the configured-llm adapter hands this to LlmPort, jev-api validates with it. */
export function answersSchema(questions: readonly Question[]): TSchema {
	return Type.Object(Object.fromEntries(questions.map((q) => [q.id, answerSchema(q)])));
}

/** Whole-response validation: a single bad answer rejects every answer. */
export function parseAnswers(raw: unknown, questions: readonly Question[]): Record<string, Answer> | null {
	if (!Value.Check(answersSchema(questions), raw)) return null;
	const byId = raw as Record<string, Record<string, unknown>>;
	const out: Record<string, Answer> = {};
	for (const q of questions) {
		const a = byId[q.id]!;
		if (q.kind === "noul") out[q.id] = { kind: "noul", probability: a.noul as number };
		else if (q.kind === "score") out[q.id] = { kind: "score", score: a.score as number };
		else {
			const probabilities = a.probabilities as Record<string, number>;
			const sum = Object.values(probabilities).reduce((s, p) => s + p, 0);
			if (Math.abs(sum - 1) > SUM_TOLERANCE) return null;
			out[q.id] = { kind: "choice", choice: a.choice as string, probabilities };
		}
	}
	return out;
}

export type CallResult = { ok: true; answers: unknown } | { ok: false; reason: "no-token" | "transport" | "invalid-answer" };

/** The shared order of checks. Adapters supply only `call`. */
export async function runJudge(args: {
	req: JudgeRequest;
	allowEgress: AllowEgress;
	cache: JudgmentCache;
	now: () => string;
	model: string;
	/** Exact bytes sent; its sha256 is the cache key. */
	body: string;
	call: () => Promise<CallResult>;
}): Promise<JudgeOutcome> {
	const { req, allowEgress, cache, now, model, body, call } = args;
	if (!req.projects.every((p) => allowEgress(p) === true)) return { kind: "no-decision", reason: "egress-denied" };
	if (req.snippets.some((s) => s.length > MAX_SNIPPET_CHARS)) return { kind: "no-decision", reason: "snippet-too-long" };

	const key = sha256Hex(body);
	const hit = await cache.get(key);
	if (hit) {
		let parsed: Record<string, Answer> | null = null;
		try {
			parsed = parseAnswers(JSON.parse(hit.responseJson), req.questions);
		} catch {
			// corrupt row: fall through to a live call
		}
		if (parsed) return { kind: "answered", answers: parsed, model, cached: true };
	}

	const result = await call();
	if (!result.ok) return { kind: "no-decision", reason: result.reason };
	const answers = parseAnswers(result.answers, req.questions);
	if (!answers) return { kind: "no-decision", reason: "invalid-answer" };
	await cache.put(key, model, JSON.stringify(result.answers), now());
	return { kind: "answered", answers, model, cached: false };
}
