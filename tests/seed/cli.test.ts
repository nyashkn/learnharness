import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import fc from "fast-check";
import { calibration, breakCycles, runCli, topoOrder, type CliDeps, type Edge, type LabelledRow } from "../../src/seed/cli";
import { createJevApiJudge } from "../../src/seed/judge/jev-api";
import { createSeedStore, type Verdict } from "../../src/seed/store";
import type { HarvestItem, LlmPort, RawItem, SessionSource } from "../../src/seed/types";
import { openNodeSqlite } from "../../src/store/sql/drivers/node-sqlite";
import { MigrationRefusedError, migrate } from "../../src/store/sql/migrate";
import { seedMigration } from "../../src/store/sql/migrations/seeds/index";
import { composeAllowEgress, loadSeedConfig, main, parseOptOut, readOptOut } from "../../scripts/seed";

const NOW = "2026-11-08T00:00:00.000Z";
const RECENT = "2026-11-01T00:00:00.000Z";
const SEED_POLICY = { calibrated: true, recencyHalfLifeDays: 60, goalWeight: 1, minMentions: 50, learnableTau: 0.5 };
const SECRET = "sk-ant-api03-ZZZZ1111YYYY2222XXXX3333";

const raw = (n: string, text: string, over: Partial<RawItem> = {}): RawItem => ({ source: "claude-history", nativeId: n, project: "/work/app", sessionId: `s-${n}`, at: RECENT, text, ...over });
const ALPHA = [raw("a1", "why does alpha borrowing fail"), raw("a2", "why is alpha lifetime confusing")];
const BETA = [raw("b1", "why does beta hashing collide"), raw("b2", "why is beta salting needed")];

interface Knobs {
	fail: Set<string>;
	noul: (id: string, snippets: string[]) => number;
	uniform: boolean;
	topics: string[];
	choice?: (id: string, options: string[]) => string | undefined;
}

/** A real jev-api judge over a fake wire: the egress guard, cache and parsing under test are the shipped ones. */
function rig(opts: { items: RawItem[]; optOut?: string[]; token?: boolean }) {
	const db = openNodeSqlite(":memory:");
	migrate(db, { ...seedMigration, lhVersion: "t" });
	const store = createSeedStore(db);
	const knobs: Knobs = {
		fail: new Set(),
		noul: (id) => ({ concept: 0.9, confusion: 0.9, standalone: 0.9, confused: 0.9, same: 0.9, goal: 0.5, ab: 0.1, ba: 0.1 })[id] ?? 0.5,
		uniform: false,
		topics: ["alpha topic", "beta topic"],
	};
	const wire: string[] = [];
	const prompts: string[] = [];
	const source = { items: opts.items };
	const src: SessionSource = { name: "fake", stats: { skipped: 0 }, async *items() { yield* source.items; } };
	const allowEgress = composeAllowEgress(opts.optOut ?? []);

	const wireFetch = (async (_url: unknown, init: { body: string }) => {
		wire.push(init.body);
		const body = JSON.parse(init.body) as { input: { state: { snippets: string[] }; questions: Record<string, { type: string; criteria?: Record<string, string> }> } };
		const { snippets } = body.input.state;
		const answers: Record<string, unknown> = {};
		for (const [id, q] of Object.entries(body.input.questions)) {
			if (knobs.fail.has(id)) return new Response("no", { status: 500 });
			if (q.type === "noul") answers[id] = { noul: knobs.noul(id, snippets) };
			else if (q.type === "score") answers[id] = { score: snippets[0]!.slice(3) === snippets[1]!.slice(3) ? 2 : 0 };
			else {
				const opts2 = Object.entries(q.criteria ?? {});
				const text = snippets.join(" ").toLowerCase();
				const custom = knobs.choice?.(id, opts2.map(([k]) => k));
				const pick =
					custom ??
					(id === "decision" ? "propose" : (opts2.find(([, d]) => d !== "no teachable concept" && text.includes(String(d).split(" ")[0]!))?.[0] ?? "none"));
				const n = opts2.length;
				answers[id] = {
					choice: pick,
					probabilities: Object.fromEntries(opts2.map(([k]) => [k, knobs.uniform ? 1 / n : k === pick ? 0.9 : 0.1 / (n - 1)])),
				};
			}
		}
		return Response.json({ success: true, result: { state: "Completed", result: { answers } } });
	}) as unknown as typeof fetch;

	const llm: LlmPort = {
		async complete(prompt, schema) {
			prompts.push(prompt);
			const props = (schema as unknown as { properties: Record<string, unknown> }).properties;
			if ("topics" in props) return { topics: knobs.topics } as never;
			const ids = [...prompt.matchAll(/^\[([0-9a-f]{64})\]/gm)].map((m) => m[1]!);
			const alpha = prompt.toLowerCase().includes("alpha");
			return { title: alpha ? "Alpha concepts" : "Beta concepts", why: "recurs", kind: "concept", evidenceIds: ids } as never;
		},
	};

	const chat = { calls: [] as { url: string; body: string }[], status: 200, created: 0, throws: false };
	const chatFetch = (async (url: string, init: { body: string }) => {
		chat.calls.push({ url, body: init.body });
		if (chat.throws) throw new Error("down");
		if (chat.status !== 200) return new Response("{}", { status: chat.status });
		chat.created++;
		return Response.json({ id: `chat-${chat.created}`, title: "x" });
	}) as unknown as typeof fetch;

	const lines: string[] = [];
	let n = 0;
	const deps: CliDeps = {
		store,
		sources: [src],
		judge: createJevApiJudge({ profile: "clef", allowEgress, cache: store.judgmentCache(), fetch: wireFetch, env: () => (opts.token === false ? undefined : "x"), now: () => NOW }),
		llm,
		allowEgress,
		fetch: chatFetch,
		baseUrl: "http://dev",
		now: () => NOW,
		newId: () => `id-${++n}`,
		out: (l) => lines.push(l),
		policy: SEED_POLICY,
	};
	const run = (...argv: string[]) => runCli(argv, deps);
	return { db, store, knobs, wire, prompts, source, chat, lines, deps, run };
}

const dump = (db: ReturnType<typeof rig>["db"]) =>
	JSON.stringify(db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((t) => db.all(`SELECT * FROM ${t.name}`)));

const decisionOf = (r: ReturnType<typeof rig>, title: string) => {
	const p = r.store.loadProposals().find((x) => x.title === title);
	return p ? { p, rank: r.store.ranks().find((x) => x.proposalId === p.id) } : undefined;
};

// ---- egress ---------------------------------------------------------------------------------------------------------

describe("composeAllowEgress", () => {
	const entry = fc.stringMatching(/^[a-z0-9]{2,8}$/);
	// a path with a home segment is redacted before matching, so the oracle below only holds without one
	const proj = fc.stringMatching(/^[A-Za-z0-9/_-]{1,20}$/).filter((p) => !/Users|home/.test(p));
	it("an empty list allows null and every project", () => {
		fc.assert(fc.property(proj, (p) => composeAllowEgress([])(null) === true && composeAllowEgress(["", "  "])(p) === true));
	});
	it("a non-empty list refuses null", () => {
		fc.assert(fc.property(fc.array(entry, { minLength: 1 }), (list) => composeAllowEgress(list)(null) === false));
	});
	it("opted-out projects are refused, others allowed", () => {
		fc.assert(
			fc.property(fc.array(entry, { minLength: 1 }), proj, (list, p) => {
				const blank = /^[/_-]+$/.test(p); // no letter or digit left: treated as null, refused once a list exists
				const blocked = blank || list.some((e) => p.toLowerCase().includes(e));
				assert.equal(composeAllowEgress(list)(p), !blocked);
			}),
		);
	});
	it("a listed name is refused inside a path", () => {
		assert.equal(composeAllowEgress(["secretco"])("/work/SecretCo/app"), false);
	});
});

describe("end-to-end egress through scan", () => {
	const items = [raw("n1", "why does ZQXNULLMARK alpha fail", { project: null }), raw("o1", "why does ZQXOPTMARK alpha fail", { project: "/work/secretco/app" }), ...ALPHA];
	const reach = (r: ReturnType<typeof rig>, marker: string) => r.wire.some((w) => w.includes(marker)) || r.prompts.some((p) => p.includes(marker));
	it("with an opt-out list, neither a null-project nor an opted-out marker reaches the wire or an LLM prompt", async () => {
		const r = rig({ items, optOut: ["secretco"] });
		assert.equal(await r.run("scan", "--goals", "learn rust"), 0);
		assert.equal(reach(r, "ZQXNULLMARK"), false);
		assert.equal(reach(r, "ZQXOPTMARK"), false);
		assert.ok(r.wire.length > 0);
	});
	it("with an empty list, the null-project item does reach both", async () => {
		const r = rig({ items, optOut: [] });
		await r.run("scan");
		assert.equal(reach(r, "ZQXNULLMARK"), true);
		assert.equal(r.wire.some((w) => w.includes("ZQXNULLMARK")), true);
		assert.equal(r.prompts.some((p) => p.includes("ZQXNULLMARK")), true);
	});
});

describe("opt-out entries meet redacted projects (lh-an0)", () => {
	const reach = (r: ReturnType<typeof rig>, marker: string) => r.wire.some((w) => w.includes(marker)) || r.prompts.some((p) => p.includes(marker));
	const marked = (project: string | null) => raw("o1", "why does ZQXOPTMARK alpha fail", { project });
	// entry written one way, project arriving another: path vs path, punctuation vs hyphens, path vs omp memory slug
	const cases: [string, string][] = [
		["/Users/alice/work/client_x", "/Users/alice/work/client_x/src"],
		["/Users/alice/work/client_x", "/Users/bob/work/client_x"],
		["client_x", "-Users-alice-work-client-x"],
		["client.x", "-Users-alice-work-client-x"],
		["client x", "/Users/alice/work/client-x"],
		["Client_X", "/home/carol/code/CLIENT.x"],
		["/Users/alice/work/client_x", "-Users-alice-work-client-x"],
	];
	for (const [entry, project] of cases) {
		it(`entry ${JSON.stringify(entry)} blocks project ${JSON.stringify(project)} through scan`, async () => {
			const r = rig({ items: [marked(project), ...ALPHA], optOut: [entry] });
			assert.equal(await r.run("scan"), 0);
			assert.equal(reach(r, "ZQXOPTMARK"), false);
			assert.ok(r.wire.length > 0, "unrelated items still go out");
		});
	}
	it("an unrelated project is not blocked by those entries", async () => {
		const r = rig({ items: [marked("/Users/alice/work/other"), ...ALPHA], optOut: ["/Users/alice/work/client_x"] });
		await r.run("scan");
		assert.equal(reach(r, "ZQXOPTMARK"), true);
	});
	it("a blank or whitespace project is refused once a list exists, allowed without one", async () => {
		for (const project of ["", "   ", "\t", "/"]) {
			const withList = rig({ items: [marked(project), ...ALPHA], optOut: ["secretco"] });
			await withList.run("scan");
			assert.equal(reach(withList, "ZQXOPTMARK"), false, JSON.stringify(project));
			const without = rig({ items: [marked(project), ...ALPHA], optOut: [] });
			await without.run("scan");
			assert.equal(reach(without, "ZQXOPTMARK"), true, JSON.stringify(project));
		}
	});
	it("an entry that canonicalises to nothing is dropped, not a block-all", () => {
		assert.equal(composeAllowEgress(["/Users/alice"])("~/work/app"), true);
		assert.equal(composeAllowEgress(["/Users/alice"])(null), true);
	});
});

// ---- redaction ------------------------------------------------------------------------------------------------------

describe("redaction", () => {
	it("a planted secret reaches no table, prompt, wire body or list output", async () => {
		const r = rig({ items: [raw("s1", `why does alpha fail ${SECRET} mail me@example.com`), ...ALPHA] });
		await r.run("scan");
		await r.run("list");
		const all = [dump(r.db), ...r.wire, ...r.prompts, ...r.lines].join("\n");
		assert.equal(all.includes(SECRET), false);
		assert.equal(all.includes("me@example.com"), false);
		assert.ok(all.includes("[redacted:secret]"));
	});
	it("the store redacts even a forged HarvestItem", () => {
		const r = rig({ items: [] });
		const forged: HarvestItem = { id: "x", source: "claude-history", project: "/Users/bob/p", sessionId: null, at: RECENT, signal: null, textRedacted: `key ${SECRET}` };
		r.store.upsertItems([forged]);
		const d = dump(r.db);
		assert.equal(d.includes(SECRET), false);
		assert.equal(d.includes("/Users/bob"), false);
	});
});

// ---- store ------------------------------------------------------------------------------------------------------------

describe("store", () => {
	it("a newer schema or wrong kind is refused", () => {
		const db = openNodeSqlite(":memory:");
		db.exec("CREATE TABLE lh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO lh_meta VALUES ('store_kind','seeds'),('schema_version','99')");
		assert.throws(() => migrate(db, { ...seedMigration, lhVersion: "t" }), (e) => e instanceof MigrationRefusedError && e.reason === "newer-schema");
	});
	it("saveAccept is atomic: a failed insert leaves the status alone", () => {
		const r = rig({ items: [] });
		assert.throws(() => r.store.saveAccept({ proposalId: "ghost", chatId: "c", firstMessage: "m", at: NOW }));
		assert.equal(r.store.accepts().length, 0);
	});
	it("the seeds ladder creates the accept, rank and review tables", () => {
		const r = rig({ items: [] });
		const names = r.db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table'").map((t) => t.name);
		for (const t of ["proposal_accept", "proposal_rank", "review_item", "label"]) assert.ok(names.includes(t), t);
	});
});

// ---- pure ordering -----------------------------------------------------------------------------------------------------

describe("cycle breaking and topo sort", () => {
	it("a 3-cycle loses its lowest-probability edge", () => {
		const e: Edge[] = [{ from: "a", to: "b", p: 0.9 }, { from: "b", to: "c", p: 0.8 }, { from: "c", to: "a", p: 0.6 }];
		assert.deepEqual(breakCycles(e), [e[0], e[1]]);
		assert.deepEqual(topoOrder(["a", "b", "c"], breakCycles(e), new Map()), ["a", "b", "c"]);
	});
	it("a self-loop and a 2-cycle are dropped; ties go to the smaller key", () => {
		const e: Edge[] = [{ from: "x", to: "x", p: 0.7 }, { from: "a", to: "b", p: 0.6 }, { from: "b", to: "a", p: 0.6 }];
		assert.deepEqual(breakCycles(e), [e[2]]);
	});
	it("a DAG is untouched and priority orders independent nodes", () => {
		const e: Edge[] = [{ from: "a", to: "c", p: 0.9 }];
		assert.deepEqual(breakCycles(e), e);
		assert.deepEqual(topoOrder(["a", "b", "c"], e, new Map([["b", 5], ["a", 1], ["c", 9]])), ["b", "a", "c"]);
	});
	const edgeSet = fc.array(fc.record<Edge>({ from: fc.constantFrom<string>("a", "b", "c", "d", "e"), to: fc.constantFrom<string>("a", "b", "c", "d", "e"), p: fc.double({ min: 0.5, max: 1, noNaN: true }) }), { maxLength: 14 });
	it("random graphs: the result is a subset, acyclic, and the topo order respects every edge", () => {
		fc.assert(
			fc.property(edgeSet, (edges) => {
				const kept = breakCycles(edges);
				for (const e of kept) assert.ok(edges.includes(e));
				const ids = ["a", "b", "c", "d", "e"];
				const order = topoOrder(ids, kept, new Map());
				assert.deepEqual([...order].sort(), ids);
				// acyclic means every kept edge goes forward in the order
				for (const e of kept) assert.ok(order.indexOf(e.from) < order.indexOf(e.to), JSON.stringify(e));
			}),
		);
	});
});

// ---- scan pipeline --------------------------------------------------------------------------------------------------------

describe("scan", () => {
	it("creates titled, ranked, decided proposals and lists them", async () => {
		const r = rig({ items: [...ALPHA, ...BETA] });
		assert.equal(await r.run("scan"), 0);
		const a = decisionOf(r, "Alpha concepts")!;
		assert.equal(a.rank!.decision, "propose");
		assert.ok(a.p.rankScore! > 0);
		const dims = JSON.parse(a.rank!.dimensionsJson) as Record<string, number>;
		assert.deepEqual(Object.keys(dims).sort(), ["gap", "goal", "items", "recency", "score", "spread"]);
		assert.equal(dims.goal, 1); // no goals: neutral
		assert.equal(r.wire.some((w) => w.includes("learner's goals")), false);
		await r.run("list");
		assert.ok(r.lines.some((l) => l.includes("Alpha concepts")));
		assert.ok(r.lines.some((l) => l.includes("why does alpha borrowing fail")));
	});
	it("proposal ids and counts are stable across any number of rescans", async () => {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (k) => {
				const r = rig({ items: [...ALPHA, ...BETA] });
				await r.run("scan");
				const before = r.store.loadProposals().map((p) => p.id);
				for (let i = 0; i < k; i++) await r.run("scan");
				assert.deepEqual(r.store.loadProposals().map((p) => p.id), before);
			}),
			{ numRuns: 5 },
		);
	});
	it("goals add the goal question and a goal factor from the judge", async () => {
		const r = rig({ items: ALPHA });
		await r.run("scan", "--goals", "learn rust");
		const dims = JSON.parse(decisionOf(r, "Alpha concepts")!.rank!.dimensionsJson) as { goal: number };
		assert.equal(dims.goal, 1.5); // 1 + weight 1 * 0.5
	});
	it("goals are redacted: a planted secret and a home path reach neither the wire nor any table", async () => {
		const r = rig({ items: ALPHA });
		await r.run("scan", "--goals", `learn rust, key ${SECRET}, notes in /Users/bob/notes`);
		const goalWire = r.wire.filter((w) => w.includes("learner's goals"));
		assert.ok(goalWire.length > 0, "the goal question was asked");
		assert.ok(goalWire.every((w) => w.includes("learn rust")));
		const all = [dump(r.db), ...r.wire, ...r.prompts, ...r.lines].join("\n");
		assert.equal(all.includes(SECRET), false);
		assert.equal(all.includes("ZZZZ1111YYYY2222XXXX3333"), false);
		assert.equal(all.includes("/Users/bob"), false);
		assert.equal(all.includes("bob"), false);
	});
	it("a single-evidence proposal is skipped in code, with no decision call", async () => {
		const r = rig({ items: [ALPHA[0]!] });
		await r.run("scan");
		assert.equal(decisionOf(r, "Alpha concepts")!.rank!.decision, "skip");
		assert.equal(r.wire.some((w) => w.includes("teaching session")), false);
	});
	it("verify drops unsupported evidence and recomputes nItems", async () => {
		const r = rig({ items: [...ALPHA, raw("a3", "why does alpha pointer alias")] });
		r.knobs.noul = (id, s) => (id === "confused" && s[0]!.includes("pointer") ? 0.1 : 0.9);
		await r.run("scan");
		assert.equal(decisionOf(r, "Alpha concepts")!.p.nItems, 2);
	});
	it("prerequisite edges follow the asymmetry rule", async () => {
		const prereq = async (ab: number, ba: number) => {
			const r = rig({ items: [...ALPHA, ...BETA] });
			r.knobs.noul = (id) => (id === "ab" ? ab : id === "ba" ? ba : 0.9);
			await r.run("scan");
			return r.store.loadProposals().filter((p) => p.prereqOf !== null);
		};
		const fwd = await prereq(0.9, 0.1);
		assert.equal(fwd.length, 1);
		assert.equal((await prereq(0.1, 0.9)).length, 1);
		assert.notEqual((await prereq(0.1, 0.9))[0]!.id, fwd[0]!.id);
		assert.equal((await prereq(0.9, 0.9)).length, 0);
		assert.equal((await prereq(0.1, 0.1)).length, 0);
	});
	it("low topic confidence goes to review before the choice is read", async () => {
		const r = rig({ items: ALPHA });
		r.knobs.uniform = true;
		await r.run("scan");
		assert.equal(r.store.loadProposals().length, 0);
		assert.ok(r.store.reviews().some((x) => x.reason === "topic-low-confidence"));
	});
	it("a 'none' topic drops the item", async () => {
		const r = rig({ items: ALPHA });
		r.knobs.choice = () => "none";
		await r.run("scan");
		assert.equal(r.store.loadProposals().length, 0);
	});
	it("no token stops the scan with exit 1 and writes no proposals", async () => {
		const r = rig({ items: ALPHA, token: false });
		assert.equal(await r.run("scan"), 1);
		assert.ok(r.lines.some((l) => l.includes("no judge token")));
		assert.equal(r.store.loadProposals().length, 0);
		assert.equal(r.store.reviews().length, 0);
	});
});

describe("fail closed: no decision at each step routes to review, never to zero", () => {
	it("screen: items are counted in one aggregate row and nothing is proposed", async () => {
		const r = rig({ items: ALPHA });
		r.knobs.fail.add("concept");
		await r.run("scan");
		assert.equal(r.store.loadProposals().length, 0);
		assert.equal(r.store.reviews().filter((x) => x.reason === "screen-transport").length, 1);
	});
	it("topic choice", async () => {
		const r = rig({ items: ALPHA });
		r.knobs.fail.add("topic");
		await r.run("scan");
		assert.equal(r.store.loadProposals().length, 0);
		assert.equal(r.store.reviews().filter((x) => x.reason === "topic-transport").length, 1);
	});
	it("alignment: an undecided pair appends nothing", async () => {
		const r = rig({ items: ALPHA });
		await r.run("scan");
		r.knobs.fail.add("relation");
		r.source.items = [...ALPHA, raw("a9", "why does alpha move semantics work")];
		await r.run("scan");
		assert.equal(r.store.loadProposals().length, 1);
		assert.ok(r.store.reviews().some((x) => x.reason === "merge-undecided"));
	});
	it("alignment: Score says same but the companion Noul disagrees", async () => {
		const r = rig({ items: ALPHA });
		await r.run("scan");
		r.knobs.noul = (id) => (id === "same" ? 0.1 : 0.9);
		r.source.items = [...ALPHA, raw("a9", "why does alpha move semantics work")];
		await r.run("scan");
		assert.equal(r.store.loadProposals().length, 1);
		assert.ok(r.store.reviews().some((x) => x.reason === "merge-undecided"));
	});
	it("goal relevance: rank is review with a null score, not 0", async () => {
		const r = rig({ items: ALPHA });
		r.knobs.fail.add("goal");
		await r.run("scan", "--goals", "g");
		const a = decisionOf(r, "Alpha concepts")!;
		assert.equal(a.rank!.decision, "review");
		assert.equal(a.p.rankScore, null);
		assert.ok(r.store.reviews().some((x) => x.reason === "rank-review"));
	});
	it("gap: a proposal with no screen data is review", async () => {
		const r = rig({ items: ALPHA });
		await r.run("scan");
		r.db.exec("DELETE FROM judgment_cache"); // a cache hit would hide the failure
		r.knobs.fail.add("concept");
		await r.run("scan");
		const a = decisionOf(r, "Alpha concepts")!;
		assert.equal(a.rank!.decision, "review");
		assert.equal(a.p.rankScore, null);
	});
	it("decide", async () => {
		const r = rig({ items: ALPHA });
		r.knobs.fail.add("decision");
		await r.run("scan");
		assert.equal(decisionOf(r, "Alpha concepts")!.rank!.decision, "review");
	});
	it("decide: ask_user is review", async () => {
		const r = rig({ items: ALPHA });
		r.knobs.choice = (id) => (id === "decision" ? "ask_user" : undefined);
		await r.run("scan");
		assert.equal(decisionOf(r, "Alpha concepts")!.rank!.decision, "review");
	});
	it("verify: unverified evidence is kept and flagged", async () => {
		const r = rig({ items: ALPHA });
		r.knobs.fail.add("confused");
		await r.run("scan");
		const a = decisionOf(r, "Alpha concepts")!;
		assert.equal(a.rank!.decision, "propose");
		assert.equal(a.p.nItems, 2);
		assert.ok(r.store.reviews().some((x) => x.reason === "verify-no-decision"));
	});
	it("prerequisites: no decision means no edge", async () => {
		const r = rig({ items: [...ALPHA, ...BETA] });
		r.knobs.noul = (id) => (id === "ab" ? 0.9 : id === "ba" ? 0.1 : 0.9);
		r.knobs.fail.add("ab");
		await r.run("scan");
		assert.equal(r.store.loadProposals().filter((p) => p.prereqOf !== null).length, 0);
	});
});

// ---- labels, propose ---------------------------------------------------------------------------------------------------------

async function labelled(over: Parameters<typeof rig>[0] = { items: ALPHA }) {
	const r = rig(over);
	await r.run("scan");
	const p = r.store.loadProposals()[0]!;
	await r.run("label", p.id, "learn");
	return { r, p };
}

describe("labels", () => {
	it("label validates, and survives rescans", async () => {
		const { r, p } = await labelled();
		assert.equal(await r.run("label", "nope", "learn"), 1);
		await r.run("scan");
		await r.run("scan");
		assert.deepEqual(r.store.labels().map((l) => [l.proposalId, l.verdict]), [[p.id, "learn"]]);
	});
});

describe("propose", () => {
	it("posts exactly {title}, stores the first message, then marks accepted", async () => {
		const { r, p } = await labelled();
		assert.equal(await r.run("propose"), 0);
		assert.equal(r.chat.calls.length, 1);
		assert.equal(r.chat.calls[0]!.url, "http://dev/api/chats");
		assert.deepEqual(JSON.parse(r.chat.calls[0]!.body), { title: "Alpha concepts" });
		const [acc] = r.store.accepts();
		assert.equal(acc!.chatId, "chat-1");
		assert.equal(acc!.firstMessage, "I keep running into Alpha concepts (for example: why does alpha borrowing fail). Teach me it from first principles, then check my understanding.");
		assert.equal(r.store.loadProposals().find((x) => x.id === p.id)!.status, "accepted");
	});
	it("a failed POST leaves everything unchanged and exits non-zero", async () => {
		for (const mode of ["500", "throw"]) {
			const { r, p } = await labelled();
			if (mode === "500") r.chat.status = 500;
			else r.chat.throws = true;
			const before = dump(r.db);
			assert.equal(await r.run("propose"), 1);
			assert.equal(dump(r.db), before);
			assert.equal(r.store.loadProposals().find((x) => x.id === p.id)!.status, "proposed");
		}
	});
	it("a re-run never creates a second chat", async () => {
		const { r } = await labelled();
		await r.run("propose");
		await r.run("propose");
		assert.equal(r.chat.created, 1);
		assert.equal(r.chat.calls.length, 1);
	});
	it("401 and 403 explain the desktop limit and exit non-zero", async () => {
		for (const status of [401, 403]) {
			const { r } = await labelled();
			r.chat.status = status;
			assert.notEqual(await r.run("propose"), 0);
			assert.ok(r.lines.some((l) => l.includes("Home panel") && l.includes("K5")));
			assert.equal(r.store.accepts().length, 0);
		}
	});
	it("only the chats endpoint is ever called", async () => {
		const { r } = await labelled();
		await r.run("propose");
		for (const c of r.chat.calls) assert.equal(c.url, "http://dev/api/chats");
	});
	it("an opt-out list that covers the evidence blocks the call", async () => {
		const { r } = await labelled({ items: ALPHA, optOut: [] });
		const strict = composeAllowEgress(["app"]);
		r.deps.allowEgress = strict;
		await r.run("propose");
		assert.equal(r.chat.calls.length, 0);
	});
});

// ---- model-based: rescan / label / propose ----------------------------------------------------------------------------------------

describe("model-based: rescan, label, propose", () => {
	type Model = { labels: Map<string, Verdict>; accepted: Set<string>; known: Set<string>; extra: number };
	type Real = ReturnType<typeof rig>;
	const check = (m: Model, r: Real) => {
		const ids = new Set(r.store.loadProposals().map((p) => p.id));
		for (const id of m.known) assert.ok(ids.has(id), "proposal id vanished");
		assert.deepEqual(new Map(r.store.labels().map((l) => [l.proposalId, l.verdict])), m.labels);
		const acc = new Set(r.store.loadProposals().filter((p) => p.status === "accepted").map((p) => p.id));
		assert.deepEqual([...acc].sort(), [...m.accepted].sort());
		assert.equal(r.chat.created, m.accepted.size);
		assert.equal(r.store.accepts().length, m.accepted.size);
	};
	const cmds = [
		fc.constant({
			toString: () => "scan",
			check: () => true,
			async run(m: Model, r: Real) {
				await r.run("scan");
				for (const p of r.store.loadProposals()) m.known.add(p.id);
				check(m, r);
			},
		}),
		fc.constant({
			toString: () => "addItem",
			check: () => true,
			async run(m: Model, r: Real) {
				r.source.items = [...r.source.items, raw(`x${m.extra++}`, `why does alpha thing ${m.extra} work`)];
			},
		}),
		fc.tuple(fc.nat(), fc.constantFrom<Verdict>("learn", "know", "skip")).map(([i, v]) => ({
			toString: () => `label ${i} ${v}`,
			check: (m: Model) => m.known.size > 0,
			async run(m: Model, r: Real) {
				const id = [...m.known].sort()[i % m.known.size]!;
				await r.run("label", id, v);
				m.labels.set(id, v);
				check(m, r);
			},
		})),
		fc.boolean().map((ok) => ({
			toString: () => `propose ok=${ok}`,
			check: () => true,
			async run(m: Model, r: Real) {
				r.chat.status = ok ? 200 : 500;
				await r.run("propose");
				if (ok) for (const [id, v] of m.labels) if (v === "learn") m.accepted.add(id);
				check(m, r);
			},
		})),
	];
	it("labels, ids, and chats stay consistent under any command sequence", async () => {
		await fc.assert(
			fc.asyncProperty(fc.commands(cmds, { maxCommands: 12 }), async (c) => {
				const r = rig({ items: [...ALPHA, ...BETA] });
				await fc.asyncModelRun(() => ({ model: { labels: new Map<string, Verdict>(), accepted: new Set<string>(), known: new Set<string>(), extra: 0 }, real: r }), c);
			}),
			{ numRuns: 25 },
		);
	});
});

// ---- report ---------------------------------------------------------------------------------------------------------------------------

describe("report", () => {
	const rows: LabelledRow[] = [
		{ id: "p1", verdict: "know", score: 10 },
		{ id: "p2", verdict: "skip", score: 20 },
		{ id: "p3", verdict: "learn", score: 30 },
		{ id: "p4", verdict: "learn", score: 40 },
		{ id: "p5", verdict: "know", score: 50 },
		{ id: "p6", verdict: "learn", score: null },
	];
	it("matches the hand computation", () => {
		const c = calibration(rows);
		const got = c.steps.map((s) => [s.tau, s.threshold, s.predicted, s.precision, s.recall]);
		const third = 2 / 3;
		assert.deepEqual(got, [
			[0, 10, 4, 0.5, 1],
			[0.1, 10, 4, 0.5, 1],
			[0.2, 10, 4, 0.5, 1],
			[0.3, 20, 3, third, 1],
			[0.4, 20, 3, third, 1],
			[0.5, 30, 2, 0.5, 0.5],
			[0.6, 30, 2, 0.5, 0.5],
			[0.7, 30, 2, 0.5, 0.5],
			[0.8, 40, 1, 0, 0],
			[0.9, 40, 1, 0, 0],
			[1, 50, 0, null, 0],
		]);
		assert.deepEqual(c.highRankNotLearn, ["p5"]);
		assert.deepEqual(c.lowRankLearn, ["p3"]);
	});
	it("properties: 11 steps, bounded, predicted never grows with tau", () => {
		fc.assert(
			fc.property(
				fc.array(fc.record({ id: fc.uuid(), verdict: fc.constantFrom<Verdict>("learn", "know", "skip"), score: fc.double({ min: 0, max: 100, noNaN: true }) }), { minLength: 1, maxLength: 30 }),
				(rs) => {
					const c = calibration(rs);
					assert.equal(c.steps.length, 11);
					c.steps.forEach((s, i) => {
						for (const v of [s.precision, s.recall]) if (v !== null) assert.ok(v >= 0 && v <= 1);
						if (i > 0) assert.ok(s.predicted <= c.steps[i - 1]!.predicted);
					});
				},
			),
		);
	});
	it("says plainly when labels are under 70, and not at 70", async () => {
		const r = rig({ items: ALPHA });
		await r.run("scan");
		const p = r.store.loadProposals()[0]!;
		r.store.setLabel(p.id, "learn", NOW);
		await r.run("report");
		assert.ok(r.lines.some((l) => l.includes("Only 1 labels, under 70")));
		const many = rig({ items: [] });
		const ps = Array.from({ length: 70 }, (_, i) => ({ ...p, id: `q${i}`, evidenceIds: [], title: `t${i}` }));
		many.store.saveProposals(ps);
		for (const q of ps) many.store.setLabel(q.id, "learn", NOW);
		await many.run("report");
		assert.equal(many.lines.some((l) => l.includes("under 70")), false);
	});
});

// ---- composition root ------------------------------------------------------------------------------------------------------------------

describe("scripts/seed main", () => {
	const spies = () => {
		const calls: string[] = [];
		const spy = <T>(name: string, value: T) => () => (calls.push(name), value);
		const lines: string[] = [];
		return {
			calls,
			lines,
			f: {
				dataDir: "/nonexistent-data-dir",
				configFile: new URL("../../scripts/seed-config.json", import.meta.url).pathname,
				out: (l: string) => lines.push(l),
				openStore: spy("openStore", null as never) as never,
				buildSources: spy("buildSources", { sources: [], close() {} }),
				buildLlm: spy("buildLlm", Promise.resolve({} as never)),
				readOptOut: spy("readOptOut", Promise.resolve([])),
				fetch: spy("fetch", null as never) as never,
				env: spy("env", undefined),
			},
		};
	};
	it("--help opens no store and reads no source, and documents the desktop limit", async () => {
		for (const argv of [["--help"], [], ["scan", "--help"], ["--", "-h"]]) {
			const s = spies();
			assert.equal(await main(argv, s.f), 0);
			assert.deepEqual(s.calls, []);
			assert.ok(s.lines.join("\n").includes("Home panel"));
		}
	});
	it("a store with a newer schema is refused before any source is read", async () => {
		const s = spies();
		const db = openNodeSqlite(":memory:");
		db.exec("CREATE TABLE lh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO lh_meta VALUES ('store_kind','seeds'),('schema_version','99')");
		const code = await main(["scan"], { ...s.f, openStore: () => db, readOptOut: async () => [] });
		assert.equal(code, 1);
		assert.ok(s.lines.some((l) => l.includes("refused")));
		assert.equal(s.calls.includes("buildSources"), false);
	});
	it("an unreadable opt-out list aborts before the store opens", async () => {
		const s = spies();
		const code = await main(["list"], { ...s.f, readOptOut: async () => Promise.reject(Object.assign(new Error("x"), { code: "EACCES" })) });
		assert.equal(code, 1);
		assert.equal(s.calls.includes("openStore"), false);
	});
	it("opt-out file: ENOENT is empty, comments and blanks are ignored, other errors propagate", async () => {
		assert.deepEqual(await readOptOut("/x", async () => Promise.reject(Object.assign(new Error("n"), { code: "ENOENT" }))), []);
		assert.deepEqual(parseOptOut("# client\n\nPivot\n  dockblocks  \n"), ["Pivot", "dockblocks"]);
		await assert.rejects(readOptOut("/x", async () => Promise.reject(Object.assign(new Error("n"), { code: "EACCES" }))));
	});
	it("scripts/seed.ts hard-codes no token", () => {
		const text = readFileSync(new URL("../../scripts/seed.ts", import.meta.url), "utf8");
		assert.equal(/sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9]{8,}|(?:TOKEN|API_KEY|SECRET)\w*\s*[:=]\s*["'][^"']{6,}["']/.test(text), false);
	});
});

describe("rank config", () => {
	const good = { calibrated: false, recencyHalfLifeDays: 60, goalWeight: 1, minMentions: 50, learnableTau: 0.5 };
	const load = (v: unknown) => loadSeedConfig("/c.json", () => JSON.stringify(v));
	it("a valid file loads", () => {
		assert.deepEqual(load(good), good);
		assert.deepEqual(loadSeedConfig(new URL("../../scripts/seed-config.json", import.meta.url).pathname).calibrated, false);
	});
	it("a missing or non-JSON file refuses", () => {
		assert.throws(() => loadSeedConfig("/c.json", () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); }), /cannot read rank config/);
		assert.throws(() => loadSeedConfig("/c.json", () => "{nope"), /cannot read rank config/);
	});
	it("wrong type, missing key, non-positive half-life, tau out of range, extra key all refuse", () => {
		const { goalWeight: _g, ...missing } = good;
		for (const bad of [{ ...good, goalWeight: "1" }, missing, { ...good, recencyHalfLifeDays: 0 }, { ...good, recencyHalfLifeDays: -5 }, { ...good, learnableTau: 1.5 }, { ...good, extra: 1 }]) {
			assert.throws(() => load(bad), /invalid/);
		}
	});
	it("main aborts on a bad config before opening a store", async () => {
		const calls: string[] = [];
		const lines: string[] = [];
		const code = await main(["list"], { configFile: "/nonexistent.json", out: (l) => lines.push(l), openStore: () => (calls.push("open"), null as never) });
		assert.equal(code, 1);
		assert.deepEqual(calls, []);
		assert.ok(lines[0]!.includes("rank config"));
	});
	it("the uncalibrated line prints for scan, list and report only when calibrated is false", async () => {
		for (const calibrated of [false, true]) {
			for (const cmd of ["scan", "list", "report"]) {
				const r = rig({ items: ALPHA });
				r.deps.policy = { ...SEED_POLICY, calibrated };
				await r.run(cmd);
				assert.equal(r.lines.some((l) => l.includes("uncalibrated")), !calibrated, `${cmd} ${calibrated}`);
			}
		}
	});
});

describe("propose: snippet only from allowed evidence", () => {
	it("an opted-out evidence item never appears in the stored first message", async () => {
		const items = [raw("a1", "why does alpha ZQXOK fail", { project: "/work/ok" }), raw("a2", "why is alpha ZQXBLOCKED odd", { project: "/work/blocked", at: "2026-10-01T00:00:00.000Z" })];
		const { r } = await labelled({ items });
		r.deps.allowEgress = composeAllowEgress(["blocked"]);
		assert.equal(await r.run("propose"), 0);
		const msg = r.store.accepts()[0]!.firstMessage;
		assert.ok(msg.includes("ZQXOK"));
		assert.equal(msg.includes("ZQXBLOCKED"), false);
	});
});
