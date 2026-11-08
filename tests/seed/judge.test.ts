import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import fc from "fast-check";
import { createConfiguredLlmJudge } from "../../src/seed/judge/configured-llm.ts";
import { createJevApiJudge, type ProfileName } from "../../src/seed/judge/jev-api.ts";
import type { JudgeOutcome, JudgePort, JudgeRequest, JudgmentCache, Question } from "../../src/seed/judge/port.ts";
import { rankProposal, type RankConfig, type RankInput } from "../../src/seed/rank.ts";

const TOKEN = "TOKEN-9f3c1d7a-do-not-leak";
const NOW = "2026-11-08T00:00:00Z";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const QUESTIONS: readonly Question[] = [
	{ id: "n1", kind: "noul", instructions: "Does the learner ask why?" },
	{ id: "c1", kind: "choice", instructions: "Which topic?", options: { a: "alpha", b: null } },
	{ id: "s1", kind: "score", instructions: "How alike?", levels: ["different", "related", "same"] },
];
const VALID = { n1: { noul: 0.7 }, c1: { choice: "a", probabilities: { a: 0.8, b: 0.2 } }, s1: { score: 1.2 } };
const request = (over: Partial<JudgeRequest> = {}): JudgeRequest => ({
	projects: ["alpha-proj", null],
	counts: { prompts: 3, sessions: 2 },
	snippets: ["why does borrowing fail"],
	questions: QUESTIONS,
	...over,
});

type Reply =
	| { t: "answers"; answers: unknown }
	| { t: "throw" }
	| { t: "status"; code: number }
	| { t: "raw"; text: string };

function fakeCache() {
	const store = new Map<string, { model: string; responseJson: string; at: string }>();
	const counts = { gets: 0, puts: 0 };
	const cache: JudgmentCache = {
		async get(k) {
			counts.gets++;
			const row = store.get(k);
			return row ? { responseJson: row.responseJson } : null;
		},
		async put(k, model, responseJson, at) {
			counts.puts++;
			store.set(k, { model, responseJson, at });
		},
	};
	return { cache, store, counts };
}

function fakeEnv(values: Record<string, string>) {
	const read = new Set<string>();
	return { read, env: (name: string) => (read.add(name), values[name]) };
}

const ENV: Record<ProfileName, Record<string, string>> = {
	clef: { JEV_CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "acct1" },
	typesafe: { TYPESAFE_API_KEY: TOKEN, TYPESAFE_BASE_URL: "https://ts.example" },
	openrouter: { OPENROUTER_API_KEY: TOKEN },
};
const ALLOWED_NAMES: Record<ProfileName, string[]> = {
	clef: ["JEV_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
	typesafe: ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL"],
	openrouter: ["OPENROUTER_API_KEY"],
};

interface Rig {
	judge: JudgePort;
	reply: Reply;
	calls: () => number;
	/** What went to the remote: the fetch body, or the LLM prompt plus schema. */
	sent: string[];
	cache: ReturnType<typeof fakeCache>;
	envRead: Set<string>;
	headers: Record<string, string>[];
	urls: string[];
}

interface Opts {
	allow?: (p: string | null) => boolean;
	env?: Record<string, string>;
}

const KINDS: { name: string; profile?: ProfileName; build: (o: Opts) => Rig }[] = [
	...(["clef", "typesafe", "openrouter"] as const).map((profile) => ({
		name: `jev-api/${profile}`,
		profile,
		build(o: Opts): Rig {
			const cache = fakeCache();
			const e = fakeEnv(o.env ?? ENV[profile]);
			const rig: Rig = { reply: { t: "answers", answers: VALID }, sent: [], cache, envRead: e.read, headers: [], urls: [], calls: () => rig.sent.length, judge: undefined as never };
			const fetchFake = (async (url: string, init: RequestInit) => {
				rig.sent.push(init.body as string);
				rig.headers.push(init.headers as Record<string, string>);
				rig.urls.push(url);
				const r = rig.reply;
				if (r.t === "throw") throw new Error(`boom ${TOKEN}`);
				if (r.t === "status") return new Response(`err ${TOKEN}`, { status: r.code });
				if (r.t === "raw") return new Response(r.text, { status: 200 });
				const envelope = profile === "clef" ? { success: true, result: { answers: r.answers, usage: {} } } : { answers: r.answers, usage: {} };
				return new Response(JSON.stringify(envelope), { status: 200 });
			}) as unknown as typeof fetch;
			rig.judge = createJevApiJudge({ profile, allowEgress: o.allow ?? (() => true), cache: cache.cache, fetch: fetchFake, env: e.env, now: () => NOW });
			return rig;
		},
	})),
	{
		name: "configured-llm",
		build(o: Opts): Rig {
			const cache = fakeCache();
			const rig: Rig = { reply: { t: "answers", answers: VALID }, sent: [], cache, envRead: new Set(), headers: [], urls: [], calls: () => rig.sent.length, judge: undefined as never };
			const llm = {
				async complete(prompt: string, schema: unknown) {
					rig.sent.push(prompt + JSON.stringify(schema));
					const r = rig.reply;
					if (r.t === "throw" || r.t === "status") throw new Error(`boom ${TOKEN}`);
					if (r.t === "raw") return r.text as never;
					return r.answers as never;
				},
			};
			rig.judge = createConfiguredLlmJudge({ llm, allowEgress: o.allow ?? (() => true), cache: cache.cache, now: () => NOW });
			return rig;
		},
	},
];

const answered = (o: JudgeOutcome) => (assert.equal(o.kind, "answered"), o as Extract<JudgeOutcome, { kind: "answered" }>);
const noDecision = (o: JudgeOutcome, reason: string) => assert.deepEqual(o, { kind: "no-decision", reason });

for (const kind of KINDS) {
	describe(`judge: ${kind.name}`, () => {
		it("refuses at construction without a guard", () => {
			for (const bad of [undefined, null, "yes", true, {}, 0]) {
				assert.throws(() => {
					if (kind.profile) createJevApiJudge({ profile: kind.profile, allowEgress: bad as never, cache: fakeCache().cache, fetch, env: () => undefined, now: () => NOW });
					else createConfiguredLlmJudge({ llm: { complete: async () => ({}) as never }, allowEgress: bad as never, cache: fakeCache().cache, now: () => NOW });
				}, TypeError);
			}
		});

		it("answers a valid response and caches exactly that", async () => {
			const rig = kind.build({});
			const out = answered(await rig.judge.ask(request()));
			assert.equal(out.cached, false);
			assert.deepEqual(out.answers.n1, { kind: "noul", probability: 0.7 });
			assert.deepEqual(out.answers.c1, { kind: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 } });
			assert.deepEqual(out.answers.s1, { kind: "score", score: 1.2 });
			assert.equal(rig.cache.counts.puts, 1);
			if (kind.profile) assert.deepEqual([...rig.cache.store.keys()], [sha(rig.sent[0]!)]);
		});

		it("guard false: zero remote calls, zero cache reads or writes", () =>
			fc.assert(
				fc.asyncProperty(
					fc.array(fc.stringMatching(/^PRJ-[a-z0-9]{6,12}$/), { minLength: 1, maxLength: 5 }),
					fc.nat(),
					fc.boolean(),
					async (names, pick, withNull) => {
						const denied = names[pick % names.length]!;
						const rig = kind.build({ allow: (p) => p !== denied });
						const projects = withNull ? [...names, null] : names;
						noDecision(await rig.judge.ask(request({ projects })), "egress-denied");
						assert.equal(rig.calls(), 0);
						assert.equal(rig.cache.counts.gets, 0);
						assert.equal(rig.cache.counts.puts, 0);
					},
				),
			));

		it("calls the guard for every project, nulls included", async () => {
			const seen: (string | null)[] = [];
			const rig = kind.build({ allow: (p) => (seen.push(p), true) });
			await rig.judge.ask(request({ projects: ["PRJ-one", null, "PRJ-two"] }));
			assert.deepEqual(seen, ["PRJ-one", null, "PRJ-two"]);
		});

		it("property: project names never reach the remote", () =>
			fc.assert(
				fc.asyncProperty(fc.array(fc.stringMatching(/^PRJ-[A-Za-z0-9]{8,16}$/), { minLength: 1, maxLength: 6 }), async (names) => {
					const rig = kind.build({});
					answered(await rig.judge.ask(request({ projects: names })));
					for (const sent of rig.sent) for (const n of names) assert.ok(!sent.includes(n), `${n} leaked`);
				}),
			));

		const BAD: [string, unknown][] = [
			["missing id", { c1: VALID.c1, s1: VALID.s1 }],
			["noul above 1", { ...VALID, n1: { noul: 1.5 } }],
			["noul below 0", { ...VALID, n1: { noul: -0.1 } }],
			["noul null (NaN on the wire)", { ...VALID, n1: { noul: null } }],
			["noul wrong shape", { ...VALID, n1: "0.7" }],
			["choice outside options", { ...VALID, c1: { choice: "zzz", probabilities: { a: 0.8, b: 0.2 } } }],
			["choice sum off", { ...VALID, c1: { choice: "a", probabilities: { a: 0.3, b: 0.2 } } }],
			["choice probability above 1", { ...VALID, c1: { choice: "a", probabilities: { a: 1.4, b: -0.4 } } }],
			["choice extra option", { ...VALID, c1: { choice: "a", probabilities: { a: 0.5, b: 0.3, z: 0.2 } } }],
			["score above 2", { ...VALID, s1: { score: 3 } }],
			["score string", { ...VALID, s1: { score: "1" } }],
			["answers array", []],
			["answers null", null],
		];
		for (const [label, answers] of BAD) {
			it(`invalid answer (${label}) is no-decision and never cached`, async () => {
				const rig = kind.build({});
				rig.reply = { t: "answers", answers };
				noDecision(await rig.judge.ask(request()), "invalid-answer");
				assert.equal(rig.cache.counts.puts, 0);
			});
		}

		it("property: one out-of-range probability anywhere voids the whole response", () =>
			fc.assert(
				fc.asyncProperty(
					fc.oneof(fc.double({ min: 1.001, max: 1e6, noNaN: true }), fc.double({ min: -1e6, max: -0.001, noNaN: true })),
					fc.constantFrom("n1", "c1", "s1"),
					async (bad, id) => {
						const rig = kind.build({});
						const answers: Record<string, unknown> = { ...VALID };
						answers[id] = id === "n1" ? { noul: bad } : id === "s1" ? { score: bad > 0 ? 2 + bad : bad } : { choice: "a", probabilities: { a: bad, b: 1 - bad } };
						rig.reply = { t: "answers", answers };
						noDecision(await rig.judge.ask(request()), "invalid-answer");
						assert.equal(rig.cache.counts.puts, 0);
					},
				),
			));

		it("transport failure is no-decision, never cached, and the error never leaks the token", async () => {
			for (const reply of [{ t: "throw" }, { t: "status", code: 500 }, { t: "status", code: 429 }, { t: "status", code: 401 }] as Reply[]) {
				const rig = kind.build({});
				rig.reply = reply;
				const out = await rig.judge.ask(request());
				noDecision(out, "transport");
				assert.equal(rig.cache.counts.puts, 0);
				assert.ok(!JSON.stringify(out).includes(TOKEN));
			}
		});

		it("malformed JSON is invalid-answer", async () => {
			if (!kind.profile) return;
			const rig = kind.build({});
			rig.reply = { t: "raw", text: "{not json" };
			noDecision(await rig.judge.ask(request()), "invalid-answer");
			assert.equal(rig.cache.counts.puts, 0);
		});

		it("snippet cap: 300 passes, 301 is refused before any cache read or call", async () => {
			const ok = kind.build({});
			answered(await ok.judge.ask(request({ snippets: ["x".repeat(300)] })));
			const rig = kind.build({});
			noDecision(await rig.judge.ask(request({ snippets: ["fine", "x".repeat(301)] })), "snippet-too-long");
			assert.equal(rig.calls(), 0);
			assert.equal(rig.cache.counts.gets, 0);
		});

		it("same request twice: one remote call, second is cached", async () => {
			const rig = kind.build({});
			const first = answered(await rig.judge.ask(request()));
			const second = answered(await rig.judge.ask(request()));
			assert.equal(rig.calls(), 1);
			assert.equal(first.cached, false);
			assert.equal(second.cached, true);
			assert.deepEqual(second.answers, first.answers);
		});

		it("a corrupt cache row is a miss, not an answer", async () => {
			const rig = kind.build({});
			answered(await rig.judge.ask(request()));
			const [key] = [...rig.cache.store.keys()];
			rig.cache.store.get(key!)!.responseJson = JSON.stringify({ n1: { noul: 9 } });
			const again = answered(await rig.judge.ask(request()));
			assert.equal(again.cached, false);
			assert.equal(rig.calls(), 2);
		});

		it("cache key is the sha256 of the exact body; a different body is a different key", () =>
			fc.assert(
				fc.asyncProperty(fc.array(fc.string({ maxLength: 40 }), { maxLength: 3 }), fc.array(fc.string({ maxLength: 40 }), { maxLength: 3 }), async (s1, s2) => {
					const rig = kind.build({});
					await rig.judge.ask(request({ snippets: s1 }));
					await rig.judge.ask(request({ snippets: s2 }));
					const keys = [...rig.cache.store.keys()].sort();
					const sameBody = JSON.stringify(s1) === JSON.stringify(s2);
					assert.equal(keys.length, sameBody ? 1 : 2);
					if (kind.profile) assert.deepEqual(keys, [...new Set(rig.sent.map(sha))].sort());
					for (const k of keys) assert.match(k, /^[0-9a-f]{64}$/);
				}),
			));

		it("the token never appears in any outcome or sent body", async () => {
			if (!kind.profile) return;
			const rig = kind.build({});
			const out = await rig.judge.ask(request());
			assert.ok(!JSON.stringify(out).includes(TOKEN));
			for (const b of rig.sent) assert.ok(!b.includes(TOKEN));
			for (const row of rig.cache.store.values()) assert.ok(!JSON.stringify(row).includes(TOKEN));
			assert.equal(rig.headers[0]!.Authorization, `Bearer ${TOKEN}`);
		});
	});
}

describe("jev-api profiles", () => {
	for (const profile of ["clef", "typesafe", "openrouter"] as const) {
		const kind = KINDS.find((k) => k.profile === profile)!;

		it(`${profile}: only the named env vars are read`, async () => {
			const rig = kind.build({});
			await rig.judge.ask(request());
			assert.ok(rig.envRead.size > 0);
			for (const name of rig.envRead) assert.ok(ALLOWED_NAMES[profile].includes(name), `read ${name}`);
		});

		it(`${profile}: missing token is no-token with zero remote calls`, async () => {
			for (const env of [{}, { ...ENV[profile], ...Object.fromEntries(ALLOWED_NAMES[profile].map((n) => [n, ""])) }]) {
				const rig = kind.build({ env });
				noDecision(await rig.judge.ask(request()), "no-token");
				assert.equal(rig.calls(), 0);
				assert.equal(rig.cache.counts.puts, 0);
			}
		});

		it(`${profile}: pinned model, never jev-latest`, async () => {
			const rig = kind.build({});
			const out = answered(await rig.judge.ask(request()));
			assert.ok(!JSON.stringify(JSON.parse(rig.sent[0]!)).includes("latest"));
			assert.ok(out.model.includes(profile === "clef" ? "clef" : "jev-1.14.0"));
		});
	}

	it("clef: missing account id is no-token; JEV token wins over the generic one; URL and envelope", async () => {
		const clef = KINDS.find((k) => k.profile === "clef")!;
		noDecision(await clef.build({ env: { JEV_CLOUDFLARE_API_TOKEN: TOKEN } }).judge.ask(request()), "no-token");

		const rig = clef.build({ env: { JEV_CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_API_TOKEN: "other", CLOUDFLARE_ACCOUNT_ID: "acct1" } });
		await rig.judge.ask(request());
		assert.equal(rig.headers[0]!.Authorization, `Bearer ${TOKEN}`);
		assert.equal(rig.urls[0], "https://api.cloudflare.com/client/v4/accounts/acct1/ai/run");
		const body = JSON.parse(rig.sent[0]!);
		assert.equal(body.model, "@cf/cloudflare/clef");
		assert.deepEqual(Object.keys(body.input.state).sort(), ["counts", "snippets"]);
		assert.deepEqual(body.input.questions.n1, { type: "noul", instructions: "Does the learner ask why?" });
		assert.deepEqual(body.input.questions.c1.criteria, { a: "alpha", b: null });
		assert.deepEqual(body.input.questions.s1.criteria, ["different", "related", "same"]);

		const generic = clef.build({ env: { CLOUDFLARE_API_TOKEN: "generic", CLOUDFLARE_ACCOUNT_ID: "acct1" } });
		answered(await generic.judge.ask(request()));
		assert.equal(generic.headers[0]!.Authorization, "Bearer generic");
	});

	it("clef: a failed Workers AI envelope is invalid-answer", async () => {
		const rig = KINDS[0]!.build({});
		rig.reply = { t: "raw", text: JSON.stringify({ success: false, result: null }) };
		noDecision(await rig.judge.ask(request()), "invalid-answer");
	});

	it("a profile is config: unknown profile throws", () => {
		assert.throws(() => createJevApiJudge({ profile: "nope" as never, allowEgress: () => true, cache: fakeCache().cache, fetch, env: () => undefined, now: () => NOW }), RangeError);
	});
});

// Stateful cache model: a Set of bodies already answered. fc.commands shrinks to the shortest bad sequence.
describe("judge cache (model-based)", () => {
	type Real = { rig: Rig };
	type Model = { cached: Set<string>; remoteCalls: number };
	const variants = ["a", "b", "c", "d"];
	class Ask implements fc.AsyncCommand<Model, Real> {
		constructor(readonly variant: string) {}
		check = () => true;
		async run(m: Model, r: Real) {
			r.rig.reply = { t: "answers", answers: VALID };
			const out = await r.rig.judge.ask(request({ snippets: [this.variant] }));
			const expectCached = m.cached.has(this.variant);
			const o = answered(out);
			assert.equal(o.cached, expectCached);
			if (!expectCached) (m.cached.add(this.variant), m.remoteCalls++);
			assert.equal(r.rig.calls(), m.remoteCalls);
		}
		toString = () => `ask(${this.variant})`;
	}
	class AskFailing implements fc.AsyncCommand<Model, Real> {
		constructor(readonly variant: string) {}
		check = (m: Model) => !m.cached.has(this.variant);
		async run(m: Model, r: Real) {
			r.rig.reply = { t: "status", code: 503 };
			noDecision(await r.rig.judge.ask(request({ snippets: [this.variant] })), "transport");
			m.remoteCalls++;
			assert.equal(r.rig.calls(), m.remoteCalls);
			assert.equal(r.rig.cache.store.size, m.cached.size);
		}
		toString = () => `askFailing(${this.variant})`;
	}
	for (const kind of KINDS) {
		it(`${kind.name}: only fully valid answers are cached, hits skip the remote`, () =>
			fc.assert(
				fc.asyncProperty(
					fc.commands([fc.constantFrom(...variants).map((v) => new Ask(v)), fc.constantFrom(...variants).map((v) => new AskFailing(v))], { maxCommands: 25 }),
					async (cmds) => {
						const rig = kind.build({});
						const model: Model = { cached: new Set(), remoteCalls: 0 };
						await fc.asyncModelRun(() => ({ model, real: { rig } }), cmds);
						assert.equal(rig.cache.store.size, model.cached.size);
					},
				),
			));
	}
});

describe("rankProposal", () => {
	const config: RankConfig = { recencyHalfLifeDays: 30, goalWeight: 1 };
	const base: RankInput = { gap: 0.5, nItems: 3, nProjects: 1, daysSinceLast: 0, goalRelevance: 0.5 };
	const score = (over: Partial<RankInput> = {}, cfg = config) => {
		const r = rankProposal({ ...base, ...over }, cfg);
		assert.equal(r.kind, "ranked");
		return (r as Extract<typeof r, { kind: "ranked" }>).score;
	};
	const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

	it("hand-computed values", () => {
		// 0.5 * ln(4) * 1 * 1 * (1 + 1*0.5)
		near(score(), 1.039720770839918);
		// two projects: x1.5
		near(score({ nProjects: 2 }), 1.559581156259877);
		// one half-life later: x0.5
		near(score({ daysSinceLast: 30 }), 0.519860385419959);
		// goalWeight 2, relevance 1: factor 3 instead of 1.5
		near(score({ goalRelevance: 1 }, { ...config, goalWeight: 2 }), 0.5 * Math.log(4) * 3);
	});

	it("n_projects boundary is exactly 2", () => {
		const one = score({ nProjects: 1 });
		near(score({ nProjects: 0 }), one);
		near(score({ nProjects: 2 }) / one, 1.5);
		near(score({ nProjects: 3 }) / one, 1.5);
	});

	it("recency halves per half-life, in either direction of the clock", () => {
		const now = score({ daysSinceLast: 0 });
		near(score({ daysSinceLast: 30 }) / now, 0.5);
		near(score({ daysSinceLast: 60 }) / now, 0.25);
		near(score({ daysSinceLast: -5 }), now);
		near(score({ daysSinceLast: 10 }, { ...config, recencyHalfLifeDays: 10 }) / now, 0.5);
	});

	it("property: strictly increasing in nItems, decreasing in age, increasing in gap", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 1, max: 1000 }), fc.double({ min: 0.01, max: 2, noNaN: true }), (n, d, gap) => {
				assert.ok(score({ nItems: n + d, gap }) > score({ nItems: n, gap }));
			}),
		);
		fc.assert(
			fc.property(fc.double({ min: 0, max: 300, noNaN: true }), fc.double({ min: 1, max: 300, noNaN: true }), (days, more) => {
				assert.ok(score({ daysSinceLast: days + more }) < score({ daysSinceLast: days }));
			}),
		);
		fc.assert(
			fc.property(fc.double({ min: 0.01, max: 1, noNaN: true }), fc.double({ min: 0.01, max: 1, noNaN: true }), (a, b) => {
				fc.pre(b - a > 1e-6);
				assert.ok(score({ gap: a }) < score({ gap: b }));
			}),
		);
	});

	it("property: dimensions carry each factor so weights can be tuned", () => {
		fc.assert(
			fc.property(fc.double({ min: 0, max: 2, noNaN: true }), fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 5 }), fc.double({ min: 0, max: 400, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (gap, nItems, nProjects, days, goal) => {
				const r = rankProposal({ gap, nItems, nProjects, daysSinceLast: days, goalRelevance: goal }, config);
				assert.equal(r.kind, "ranked");
				if (r.kind !== "ranked") return;
				assert.equal(r.dimensions.gap, gap);
				near(r.dimensions.items, Math.log(1 + nItems));
				assert.equal(r.dimensions.spread, nProjects >= 2 ? 1.5 : 1);
				near(r.dimensions.recency, 2 ** (-days / 30));
				near(r.dimensions.goal, 1 + goal);
			}),
		);
	});

	it("a missing judgment is review, never a zero score", () => {
		for (const over of [{ gap: null }, { goalRelevance: null }, { gap: Number.NaN }, { goalRelevance: Number.POSITIVE_INFINITY }]) {
			const r = rankProposal({ ...base, ...over }, config);
			assert.equal(r.kind, "review");
			assert.ok(!("score" in r));
		}
	});

	it("a real gap of 0 is a score of 0, not review", () => {
		assert.equal(score({ gap: 0 }), 0);
	});

	it("config has no defaults: a bad half-life throws", () => {
		assert.throws(() => rankProposal(base, { recencyHalfLifeDays: 0, goalWeight: 1 }), RangeError);
		assert.throws(() => rankProposal(base, {} as never), RangeError);
	});
});
