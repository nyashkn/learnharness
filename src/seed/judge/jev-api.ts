import type { AllowEgress } from "../types";
import {
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

export type ProfileName = "clef" | "typesafe" | "openrouter";
export type EnvReader = (name: string) => string | undefined;

/** Endpoint profiles are data: changing model host is config, not code. */
interface Profile {
	model: string;
	/** Tried in order; the first non-empty value is the token. */
	tokenVars: readonly string[];
	/** Other env names the URL needs; any missing one is "no-token". */
	configVars: readonly string[];
	url(env: Record<string, string>): string;
	body(model: string, state: unknown, questions: Record<string, unknown>): unknown;
	/** Envelope to the answers object, or undefined when the envelope is wrong. */
	unwrap(json: unknown): unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const plainBody = (model: string, state: unknown, questions: Record<string, unknown>) => ({ model, state, questions });
const plainUnwrap = (json: unknown) => (isRecord(json) ? json.answers : undefined);

export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
	// Workers AI REST: ref wraps the request in `input` and the reply in result (or result.result).
	clef: {
		model: "@cf/cloudflare/clef",
		tokenVars: ["JEV_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN"],
		configVars: ["CLOUDFLARE_ACCOUNT_ID"],
		url: (env) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID!)}/ai/run`,
		body: (model, state, questions) => ({ model, input: { state, questions } }),
		unwrap(json) {
			if (!isRecord(json) || json.success === false || !isRecord(json.result)) return undefined;
			const outer = json.result;
			if (typeof outer.state === "string" && outer.state !== "Completed") return undefined;
			const payload = isRecord(outer.result) ? outer.result : outer;
			return payload.answers;
		},
	},
	// The ref never shows TypeSafe's direct route (its SDK appends it), so the origin comes from config and /v1/systemone is the System One path the ref's mock endpoint serves.
	typesafe: {
		model: "jev-1.14.0",
		tokenVars: ["TYPESAFE_API_KEY"],
		configVars: ["TYPESAFE_BASE_URL"],
		url: (env) => `${env.TYPESAFE_BASE_URL!.replace(/\/+$/, "")}/v1/systemone`,
		body: plainBody,
		unwrap: plainUnwrap,
	},
	// Pinned: never the moving jev-latest alias.
	openrouter: {
		model: "typesafe/jev-1.14.0",
		tokenVars: ["OPENROUTER_API_KEY"],
		configVars: [],
		url: () => "https://openrouter.ai/api/alpha/decisions",
		body: plainBody,
		unwrap: plainUnwrap,
	},
};

const REQUEST_TIMEOUT_MS = 60_000;

export function createJevApiJudge(args: {
	profile?: ProfileName;
	allowEgress: AllowEgress;
	cache: JudgmentCache;
	fetch: typeof fetch;
	env: EnvReader;
	now: () => string;
}): JudgePort {
	requireGuard(args.allowEgress);
	const profile = PROFILES[args.profile ?? "clef"];
	if (!profile) throw new RangeError(`unknown jev-api profile: ${String(args.profile)}`);

	return {
		async ask(req: JudgeRequest): Promise<JudgeOutcome> {
			const body = JSON.stringify(profile.body(profile.model, buildState(req), wireQuestions(req.questions)));
			return runJudge({
				req,
				allowEgress: args.allowEgress,
				cache: args.cache,
				now: args.now,
				model: profile.model,
				body,
				call: async (): Promise<CallResult> => {
					const token = profile.tokenVars.map((n) => args.env(n)).find((v) => v);
					const config: Record<string, string> = {};
					for (const name of profile.configVars) {
						const value = args.env(name);
						if (!value) return { ok: false, reason: "no-token" };
						config[name] = value;
					}
					if (!token) return { ok: false, reason: "no-token" };

					let text: string;
					try {
						const res = await args.fetch(profile.url(config), {
							method: "POST",
							headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
							body,
							signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
						});
						if (!res.ok) return { ok: false, reason: "transport" };
						text = await res.text();
					} catch {
						// Never surface the error: a reflecting endpoint or proxy could echo the token.
						return { ok: false, reason: "transport" };
					}
					try {
						const answers = profile.unwrap(JSON.parse(text));
						return answers === undefined ? { ok: false, reason: "invalid-answer" } : { ok: true, answers };
					} catch {
						return { ok: false, reason: "invalid-answer" };
					}
				},
			});
		},
	};
}
