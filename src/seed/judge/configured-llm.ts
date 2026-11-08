import type { AllowEgress, LlmPort } from "../types";
import {
	answersSchema,
	buildState,
	requireGuard,
	runJudge,
	wireQuestions,
	type CallResult,
	type JudgeOutcome,
	type JudgePort,
	type JudgeRequest,
	type JudgmentCache,
} from "./port";

export const CONFIGURED_LLM_MODEL = "configured-llm";

/** Fallback for owners without a Jev endpoint. Remote unless the provider is local, so it passes the same guard. */
export function createConfiguredLlmJudge(args: {
	llm: LlmPort;
	allowEgress: AllowEgress;
	cache: JudgmentCache;
	now: () => string;
}): JudgePort {
	requireGuard(args.allowEgress);
	return {
		async ask(req: JudgeRequest): Promise<JudgeOutcome> {
			const state = buildState(req);
			const questions = wireQuestions(req.questions);
			const body = JSON.stringify({ model: CONFIGURED_LLM_MODEL, state, questions });
			return runJudge({
				req,
				allowEgress: args.allowEgress,
				cache: args.cache,
				now: args.now,
				model: CONFIGURED_LLM_MODEL,
				body,
				call: async (): Promise<CallResult> => {
					const prompt =
						"Answer every question about the state below. Reply with one answer per question id: " +
						'noul -> {"noul": probability 0..1}; choice -> {"choice": option, "probabilities": {option: probability}} summing to 1; ' +
						'score -> {"score": 0..2}.\n' +
						JSON.stringify({ state, questions });
					try {
						return { ok: true, answers: await args.llm.complete(prompt, answersSchema(req.questions)) };
					} catch {
						return { ok: false, reason: "transport" };
					}
				},
			});
		},
	};
}
