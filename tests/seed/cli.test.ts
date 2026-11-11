import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import fc from "fast-check";
import { calibration, breakCycles, parseCommand, runCli, topoOrder, type CliDeps, type Edge, type LabelledRow } from "../../src/seed/cli";
import { piModels } from "../../src/agent/models";
import { signetSummarySource } from "../../src/seed/sources/signet";
import { createJevApiJudge } from "../../src/seed/judge/jev-api";
import { createSeedStore, type Verdict } from "../../src/seed/store";
import type { HarvestItem, LlmPort, RawItem, SessionSource } from "../../src/seed/types";
import { openNodeSqlite } from "../../src/store/sql/drivers/node-sqlite";
import { MigrationRefusedError, migrate } from "../../src/store/sql/migrate";
import { seedMigration } from "../../src/store/sql/migrations/seeds/index";
import { composeAllowEgress, LlmUnavailableError, loadSeedConfig, main, parseOptOut, readOptOut, realLlm } from "../../scripts/seed";
import { blocksNothing, createAllowEgress } from "../../src/seed/egress";
import { redact } from "../../src/seed/redact";

const NOW = "2026-11-08T00:00:00.000Z";
const RECENT = "2026-11-01T00:00:00.000Z";
const SEED_POLICY = { calibrated: true, recencyHalfLifeDays: 60, goalWeight: 1, minMentions: 50, learnableTau: 0.5 };
const SECRET = "sk-ant-api03-ZZZZ1111YYYY2222XXXX3333";

const raw = (n: string, text: string, over: Partial<RawItem> = {}): RawItem => ({ source: "claude-history", nativeId: n, project: "/work/app", sessionId: `s-${n}`, at: over.at ?? RECENT, sessionAt: over.at ?? RECENT, text, ...over });
const ALPHA = [raw("a1", "why does alpha borrowing fail"), raw("a2", "why is alpha lifetime confusing")];
const BETA = [raw("b1", "why does beta hashing collide"), raw("b2", "why is beta salting needed")];

interface Knobs {
	fail: Set<string>;
	noul: (id: string, snippets: string[]) => number;
	uniform: boolean;
	topics: string[];
	choice?: (id: string, options: string[]) => string | undefined;
	draft?: { title: string; why: string };
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
			return { title: knobs.draft?.title ?? (alpha ? "Alpha concepts" : "Beta concepts"), why: knobs.draft?.why ?? "recurs", kind: "concept", evidenceIds: ids } as never;
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
	const swallowedSlug = ["Qz7-x9K", "mP2v-R8tL", "w4Yb-N6s", "Jd3h-u5Fq", "cE1"].join("");
	const ignoredEntries = ["/Users/alice", "C:\\Users\\bob", "/home/carol", "~", "/", swallowedSlug];
	it("a non-empty list of only ignored entries refuses null and blank projects, allows named ones (lh-6tw)", () => {
		assert.ok(ignoredEntries.every(blocksNothing), "precondition: every entry blocks nothing");
		fc.assert(
			fc.property(fc.array(fc.constantFrom(...ignoredEntries), { minLength: 1, maxLength: 6 }), fc.constantFrom("", "  ", "/-_"), proj, (list, blank, p) => {
				const allow = composeAllowEgress(list);
				assert.equal(allow(null), false);
				assert.equal(allow(blank), false);
				assert.equal(allow(p), !/^[/_-]+$/.test(p));
			}),
		);
	});
	it("a mixed list: null refused, a project refused iff blank or it contains an effective entry (lh-6tw)", () => {
		const tagged = fc.oneof(entry.map((e) => ({ e, eff: true })), fc.constantFrom(...ignoredEntries).map((e) => ({ e, eff: false })));
		fc.assert(
			fc.property(fc.array(tagged, { minLength: 1, maxLength: 6 }).filter((l) => l.some((t) => t.eff)), proj, (tags, p) => {
				const allow = composeAllowEgress(tags.map((t) => t.e));
				assert.equal(allow(null), false);
				assert.equal(allow(p), !(/^[/_-]+$/.test(p) || tags.some((t) => t.eff && p.toLowerCase().includes(t.e))));
			}),
		);
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
	it("a no-project row does not reach the wire when every opt-out entry is ignored, and does without a list (lh-6tw)", async () => {
		const blocked = rig({ items: [marked(null), ...ALPHA], optOut: ["/Users/alice"] });
		await blocked.run("scan");
		assert.equal(reach(blocked, "ZQXOPTMARK"), false);
		const open = rig({ items: [marked(null), ...ALPHA], optOut: [] });
		await open.run("scan");
		assert.equal(reach(open, "ZQXOPTMARK"), true);
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
	it("an entry that canonicalises to nothing blocks no named project but refuses no-project rows (lh-6tw)", () => {
		assert.equal(composeAllowEgress(["/Users/alice"])("~/work/app"), true);
		assert.equal(composeAllowEgress(["/Users/alice"])(null), false);
	});
	it("blocksNothing agrees with the allow function it feeds (lh-aei)", () => {
		const word = fc.constantFrom("acme", "client_x", "Pivot", "dockblocks", "a b", "x.y");
		const home = fc.constantFrom("/Users/alice", "C:\\Users\\bob", "/home/carol", "~", "/");
		const sep = fc.constantFrom("/", "-", "_", " ", ".", "\\");
		const entropy = fc.stringMatching(/^[A-Za-z0-9_-]{24,48}$/);
		const entry = fc.array(fc.oneof(word, home, sep, entropy), { minLength: 1, maxLength: 4 }).map((a) => a.join(""));
		fc.assert(
			fc.property(entry, (e) => {
				const allow = createAllowEgress([e]);
				if (blocksNothing(e)) return [`~/work/${e}`, `~-work-${e.replace(/[^A-Za-z0-9]+/g, "-")}`, e].every((p) => allow(p));
				return allow(e) === false;
			}),
			{ numRuns: 500 },
		);
	});
	it("an all-ignored list fails closed: no-project rows refused for home-path and swallowed entries, named projects allowed (lh-6tw)", () => {
		const swallowed = ["Qz7-x9K", "mP2v-R8tL", "w4Yb-N6s", "Jd3h-u5Fq", "cE1"].join("");
		assert.ok(blocksNothing("/Users/alice") && blocksNothing(swallowed), "precondition: both entries block nothing, so the CLI counts 0");
		for (const e of ["/Users/alice", swallowed]) {
			assert.equal(composeAllowEgress([e])(null), false);
			assert.equal(composeAllowEgress([e])("~/work/app"), true);
		}
	});
});

describe("a project that redaction swallowed counts as no provenance (lh-3p3)", () => {
	// synthetic slug from lh-3p3: long, with a digit, entropy over the split-run threshold
	const SLUG = "-Users-alice-RK-acme-2025-work-learn-projects-Mobile-Data-payments-RK-frontend-work-infra-dev-Initech";
	const reach = (r: ReturnType<typeof rig>, marker: string) => r.wire.some((w) => w.includes(marker)) || r.prompts.some((p) => p.includes(marker));
	it("with an opt-out list, its text reaches neither the wire nor an LLM prompt", async () => {
		const r = rig({ items: [raw("o1", "why does ZQXSLUGMARK alpha fail", { project: SLUG }), ...ALPHA], optOut: ["acme"] });
		assert.equal(await r.run("scan"), 0);
		assert.ok(r.store.items().some((i) => i.project?.includes("[redacted:")), "precondition: the slug was swallowed, else this test proves nothing");
		assert.equal(reach(r, "ZQXSLUGMARK"), false);
		assert.ok(r.wire.length > 0, "unrelated items still go out");
	});
	it("without a list it is allowed, like a null project", async () => {
		const r = rig({ items: [raw("o1", "why does ZQXSLUGMARK alpha fail", { project: SLUG }), ...ALPHA], optOut: [] });
		await r.run("scan");
		assert.equal(reach(r, "ZQXSLUGMARK"), true);
	});
	it("a stored placeholder project is refused once a list exists", () => {
		assert.equal(composeAllowEgress(["acme"])("~-[redacted:secret]"), false);
		assert.equal(composeAllowEgress(["acme"])("~/work/[redacted:email]/app"), false);
		assert.equal(composeAllowEgress([])("~-[redacted:secret]"), true);
	});
	it("direct calls: a raw slug redaction swallows, and a stored slug a second redaction swallows, are refused once a list exists (lh-09r)", () => {
		assert.ok(redact(SLUG).includes("[redacted:"), "precondition: the raw slug is swallowed");
		assert.equal(composeAllowEgress(["unrelated"])(SLUG), false);
		assert.equal(composeAllowEgress([])(SLUG), true);
		// redact is idempotent since lh-9hg: the raw slug is swallowed on the first pass
		assert.ok(redact("-Users-alice-EK-Mobile-Shared-Documents-Initech-api-2025-dev").includes("[redacted:"), "first pass swallows the raw slug (lh-9hg)");
		// a legacy row: what redact(raw) stored before lh-9hg, clean, and swallowed by the second redaction egress runs on it
		const stored = "~-EK-Mobile-Shared-Documents-Initech-api-2025-dev";
		assert.ok(redact(stored).includes("[redacted:"), "precondition: the legacy row is swallowed by a second redaction");
		assert.equal(composeAllowEgress(["unrelated"])(stored), false);
		assert.equal(composeAllowEgress([])(stored), true);
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

describe("a scan stops on the first failure (lh-iqc)", () => {
	const STOPPED = "scan stopped: the judge gave no decision (transport). Nothing more was sent; this run's results are incomplete.";
	// how many judge requests asked the question with this id
	const asked = (r: ReturnType<typeof rig>, id: string) => r.wire.filter((w) => Object.hasOwn((JSON.parse(w) as { input: { questions: object } }).input.questions, id)).length;
	const cases: ReadonlyArray<readonly [step: string, id: string, items: RawItem[], argv: string[]]> = [
		["screen", "concept", ALPHA, []],
		["topic choice", "topic", ALPHA, []],
		["goal relevance", "goal", ALPHA, ["--goals", "learn rust"]],
		["decide", "decision", ALPHA, []],
		["verify", "confused", ALPHA, []],
		["prerequisites", "ab", [...ALPHA, ...BETA], []],
	];
	for (const [step, id, items, argv] of cases) {
		it(`${step}: a judge 500 exits 1 and nothing more is asked`, async () => {
			const r = rig({ items });
			r.knobs.fail.add(id);
			assert.equal(await r.run("scan", ...argv), 1);
			assert.ok(r.lines.includes(STOPPED));
			assert.equal(asked(r, id), 1, "the failing question is asked once, then the scan stops");
			assert.equal(r.wire.length, r.wire.findIndex((w) => Object.hasOwn((JSON.parse(w) as { input: { questions: object } }).input.questions, id)) + 1, "no request after the failing one");
		});
	}
	it("alignment: a judge 500 on a rescan exits 1", async () => {
		const r = rig({ items: ALPHA });
		await r.run("scan");
		r.knobs.fail.add("relation");
		r.source.items = [...ALPHA, raw("a9", "why does alpha move semantics work")];
		assert.equal(await r.run("scan"), 1);
		assert.ok(r.lines.includes(STOPPED));
	});
	it("the extractor failing on topics exits 1 before any topic question", async () => {
		const r = rig({ items: ALPHA });
		r.deps.llm = { complete: async () => Promise.reject(new Error("500")) };
		assert.equal(await r.run("scan"), 1);
		assert.ok(r.lines.includes("scan stopped: the extractor failed while naming topics. Nothing more was sent; this run's results are incomplete."));
		assert.equal(asked(r, "topic"), 0);
	});
	it("a schema-invalid topic reply exits 1", async () => {
		const r = rig({ items: ALPHA });
		r.deps.llm = { complete: async () => ({ nope: true }) as never };
		assert.equal(await r.run("scan"), 1);
		assert.ok(r.lines.includes("scan stopped: the extractor's topic reply did not match the schema. Nothing more was sent; this run's results are incomplete."));
	});
	it("a draft the extractor cannot write exits 1 before any decision", async () => {
		const r = rig({ items: ALPHA });
		r.knobs.draft = { title: " ", why: "recurs" };
		assert.equal(await r.run("scan"), 1);
		assert.ok(r.lines.includes("scan stopped: the extractor failed while drafting a title (invalid-output). Nothing more was sent; this run's results are incomplete."));
		assert.equal(asked(r, "decision"), 0);
	});
	it("an egress refusal is not a failure: the scan goes on", async () => {
		const r = rig({ items: [raw("o1", "why does alpha secretco fail", { project: "/work/secretco" }), ...ALPHA], optOut: ["secretco"] });
		assert.equal(await r.run("scan"), 0);
	});
});

describe("model text is redacted and clipped before it reaches the judge (lh-8o7)", () => {
	const leaves = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : []);
	it("a planted secret and a home path in topic names, titles and why never reach a judge body; no string there is over 400 chars", async () => {
		const r = rig({ items: ALPHA });
		r.knobs.topics = [`alpha ${SECRET} ${"x".repeat(400)}`, "beta topic"];
		r.knobs.draft = { title: `Alpha ${SECRET} ${"long ".repeat(200)}`, why: `see /Users/bob/notes and ${SECRET}` };
		assert.equal(await r.run("scan", "--goals", "learn rust"), 0);
		const bodies = r.wire.map((w) => JSON.parse(w) as unknown);
		for (const id of ["topic", "goal", "decision", "confused"]) assert.ok(r.wire.some((w) => w.includes(`"${id}"`)), `the ${id} step ran`);
		for (const leaf of bodies.flatMap(leaves)) {
			assert.equal(redact(leaf), leaf);
			assert.ok(leaf.length <= 400, `${leaf.length} chars`);
		}
		const all = r.wire.join("\n");
		assert.equal(all.includes("ZZZZ1111YYYY2222XXXX3333"), false);
		assert.equal(all.includes("/Users/bob"), false);
	});
});

describe("align and prereq judge steps never carry raw model title or why (lh-w21)", () => {
	const leaves = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : []);
	it("a planted token and home path in the draft title and why reach no judge body, and the align and prereq steps ran", async () => {
		const body = "QQQQ9999RRRR8888SSSS7777";
		const token = `sk-ant-api03-${body}`; // built at runtime, not a literal token
		const r = rig({ items: [...ALPHA, ...BETA] });
		const real = r.deps.llm;
		// every draft carries planted text: the first scan makes two new proposals (goal, decision, prereq), the second aligns against them
		r.deps.llm = { complete: async (prompt, schema) => { const d = (await real.complete(prompt, schema)) as { title?: string; why?: string }; return "title" in d ? ({ ...d, title: `${d.title} ${token} /Users/bob/x`, why: `see /Users/bob/notes ${token}` } as never) : (d as never); } };
		assert.equal(await r.run("scan", "--goals", "learn rust"), 0);
		assert.equal(await r.run("scan", "--goals", "learn rust"), 0);
		// each step must have carried the planted title, redacted, so a skipped or clean-titled step cannot pass this test
		for (const id of ["same", "goal", "decision", "ab"]) assert.ok(r.wire.some((w) => w.includes(`"${id}"`) && w.includes("[redacted:secret] ~/x")), `the ${id} step carried the redacted title`);
		for (const id of ["goal", "decision"]) assert.ok(r.wire.some((w) => w.includes(`"${id}"`) && w.includes("see ~/notes [redacted:secret]")), `the ${id} step carried the redacted why`);
		for (const leaf of r.wire.flatMap((w) => leaves(JSON.parse(w) as unknown))) assert.equal(redact(leaf), leaf);
		const all = r.wire.join("\n");
		assert.equal(all.includes(body), false);
		assert.equal(all.includes("/Users/bob"), false);
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
	it("an existing older seeds.sqlite upgrades through main and leaves its R5 backup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lh-seed-upgrade-"));
		try {
			const file = join(dir, "seeds.sqlite");
			const v1 = openNodeSqlite(file);
			migrate(v1, { ...seedMigration, rungs: seedMigration.rungs.slice(0, 1), lhVersion: "t" });
			v1.close();
			const code = await main(["list"], { ...spies().f, dataDir: dir, openStore: openNodeSqlite, readOptOut: async () => [] });
			assert.equal(code, 0);
			const after = openNodeSqlite(file);
			assert.equal(after.get<{ value: string }>("SELECT value FROM lh_meta WHERE key = 'schema_version'")?.value, String(seedMigration.rungs.length));
			after.close();
			assert.equal(readdirSync(dir).filter((f) => /^seeds\.bak-v1-\d+\.sqlite$/.test(f)).length, 1, "the pre-upgrade backup");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
	it("opt-out file: whitespace then # starts an inline comment, a # inside an entry stays (lh-09r)", () => {
		assert.deepEqual(parseOptOut("acme  # client\nc#-tools\nfoo\t#bar\n  # note\n#x\n"), ["acme", "c#-tools", "foo"]);
		const entry = fc.stringMatching(/^[a-z0-9_.-][a-z0-9#_.-]{0,10}$/);
		fc.assert(fc.property(entry, fc.constantFrom(" ", "  ", "\t"), fc.string().filter((s) => !s.includes("\n")), (e, sep, note) => {
			assert.deepEqual(parseOptOut(`${e}${sep}# ${note}`), [e]);
		}));
	});
	describe("opt-out line (lh-h9y)", () => {
		const NOTE = "opt-out:";
		// real file reads in a temp dir; the store is in memory; the first outbound call snapshots what was printed so far
		async function ordering(command: "scan" | "propose", optOutText: string | null, extra: string[] = []) {
			const dir = mkdtempSync(join(tmpdir(), "seed-optout-"));
			try {
				if (optOutText !== null) writeFileSync(join(dir, "seed-optout.txt"), optOutText);
				const lines: string[] = [];
				const atFirstCall: string[][] = [];
				const mark = () => atFirstCall.push([...lines]);
				const item = { id: "i1", source: "claude-history" as const, project: "/work/app", sessionId: "s1", at: RECENT, signal: "confusion" as const, textRedacted: "why does alpha borrowing fail" };
				const shared = openNodeSqlite(":memory:");
				migrate(shared, { ...seedMigration, lhVersion: "t" });
				const seed = createSeedStore(shared);
				seed.upsertItems([item]);
				if (command === "propose") {
					seed.saveProposals([{ id: "p1", title: "Alpha", why: "w", kind: "concept", prereqOf: null, firstSeen: RECENT, lastSeen: RECENT, nItems: 1, nProjects: 1, rankScore: 1, status: "proposed", mergedInto: null, evidenceIds: ["i1"] }]);
					seed.setLabel("p1", "learn", NOW);
				}
				const src: SessionSource = { name: "fake", stats: { skipped: 0 }, async *items() { yield raw("a1", item.textRedacted); } };
				const code = await main([command, ...extra], {
					dataDir: dir,
					configFile: new URL("../../scripts/seed-config.json", import.meta.url).pathname,
					lhVersion: () => "t",
					openStore: () => shared,
					buildSources: () => ({ sources: [src], close() {} }),
					buildLlm: async () => (mark(), { complete: async () => Promise.reject(new Error("no model")) }),
					env: () => "x",
					fetch: (async () => (mark(), Response.json({ id: "c1" }, { status: command === "propose" ? 200 : 500 }))) as unknown as typeof fetch,
					out: (l) => lines.push(l),
				}).catch(() => -1);
				return { dir, code, lines, atFirstCall };
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		const optLines = (ls: string[]) => ls.filter((l) => l.startsWith(NOTE));
		for (const command of ["scan", "propose"] as const) {
			it(`${command}: found file prints count and absolute path before the first outbound call`, async () => {
				const r = await ordering(command, "# note\nclient_x\nother\n");
				const file = join(r.dir, "seed-optout.txt");
				assert.ok(r.atFirstCall.length >= 1, "an outbound call happened");
				assert.deepEqual(optLines(r.atFirstCall[0]!), [`opt-out: 2 entries from ${file}`]);
				assert.deepEqual(optLines(r.lines), [`opt-out: 2 entries from ${file}`]);
			});
			it(`${command}: missing file says so before the first outbound call`, async () => {
				const r = await ordering(command, null);
				assert.ok(r.atFirstCall.length >= 1);
				assert.deepEqual(optLines(r.atFirstCall[0]!), [`opt-out: 0 entries, file not found at ${join(r.dir, "seed-optout.txt")}`]);
			});
			it(`${command}: empty file prints zero entries from the path, not "not found"`, async () => {
				const r = await ordering(command, "\n# only a comment\n");
				assert.ok(r.atFirstCall.length >= 1);
				assert.deepEqual(optLines(r.atFirstCall[0]!), [`opt-out: 0 entries from ${join(r.dir, "seed-optout.txt")}`]);
			});
		}
		it("counts only entries that block something and names each ignored one, redacted (lh-aei)", async () => {
			const swallowed = ["aB3xK9", "mQ7zT2pL", "vR8nW4yC", "5hJ6dF1s", "Gq0eU"].join("");
			assert.ok(redact(swallowed).includes("[redacted:"), "the slug really is swallowed");
			const r = await ordering("scan", `acme\n/Users/alice\nC:\\Users\\bob\n${swallowed}\n`);
			const file = join(r.dir, "seed-optout.txt");
			const ignoring = (e: string) => `opt-out: ignoring entry ${JSON.stringify(redact(e))}: after redaction it names no project, so it blocks nothing`;
			assert.deepEqual(optLines(r.lines), [`opt-out: 1 entries from ${file}`, ignoring("/Users/alice"), ignoring("C:\\Users\\bob"), ignoring(swallowed)]);
			assert.ok(!r.lines.join("\n").includes(swallowed), "the raw slug is never printed");
		});
		it("an all-ignored file says 0 usable entries and that no-project rows are blocked, then names each ignored one (lh-6tw)", async () => {
			const swallowed = ["aB3xK9", "mQ7zT2pL", "vR8nW4yC", "5hJ6dF1s", "Gq0eU"].join("");
			const r = await ordering("scan", `/Users/alice\n${swallowed}\n`);
			const file = join(r.dir, "seed-optout.txt");
			const ignoring = (e: string) => `opt-out: ignoring entry ${JSON.stringify(redact(e))}: after redaction it names no project, so it blocks nothing`;
			assert.deepEqual(optLines(r.lines), [`opt-out: 0 usable entries from ${file} (2 ignored); rows with no project are blocked`, ignoring("/Users/alice"), ignoring(swallowed)]);
			assert.ok(!r.lines.join("\n").includes(swallowed), "the raw slug is never printed");
		});
		it("scan with the configured-llm judge prints it before the model is built", async () => {
			const r = await ordering("scan", "x\n", ["--judge", "configured-llm"]);
			assert.ok(r.atFirstCall.length >= 1, "the model was built");
			assert.deepEqual(optLines(r.atFirstCall[0]!).length, 1);
		});
		it("list, report, label and --help print no opt-out line", async () => {
			for (const argv of [["list"], ["report"], ["label", "x", "skip"], ["--help"]]) {
				const dir = mkdtempSync(join(tmpdir(), "seed-optout-"));
				try {
					const lines: string[] = [];
					const shared = openNodeSqlite(":memory:");
					await main(argv, { dataDir: dir, configFile: new URL("../../scripts/seed-config.json", import.meta.url).pathname, lhVersion: () => "t", openStore: () => shared, out: (l) => lines.push(l) });
					assert.deepEqual(optLines(lines), [], argv.join(" "));
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}
		});
	});
	it("scripts/seed.ts hard-codes no token", () => {
		const text = readFileSync(new URL("../../scripts/seed.ts", import.meta.url), "utf8");
		assert.equal(/sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9]{8,}|(?:TOKEN|API_KEY|SECRET)\w*\s*[:=]\s*["'][^"']{6,}["']/.test(text), false);
	});
});

describe("scan --since (lh-tw1.2)", () => {
	const OLD = "2026-08-01T00:00:00.000Z";
	const old = raw("old1", "why does ZQXOLDMARK alpha fail", { at: OLD });
	const badTime = raw("bad1", "why does ZQXBADTIME alpha fail", { at: "not a time" });
	const reached = (r: ReturnType<typeof rig>, marker: string) => r.wire.some((w) => w.includes(marker)) || r.prompts.some((p) => p.includes(marker));

	it("parses a UTC calendar date with or without --goals, in either order", () => {
		assert.deepEqual(parseCommand(["scan", "--since", "2026-09-10"]), { kind: "scan", goals: null, since: "2026-09-10T00:00:00.000Z" });
		assert.deepEqual(parseCommand(["scan", "--goals", "learn rust", "--since", "2026-09-10"]), { kind: "scan", goals: "learn rust", since: "2026-09-10T00:00:00.000Z" });
		assert.deepEqual(parseCommand(["scan", "--since", "2026-09-10", "--goals", "learn rust"]), { kind: "scan", goals: "learn rust", since: "2026-09-10T00:00:00.000Z" });
		assert.deepEqual(parseCommand(["scan"]), { kind: "scan", goals: null, since: null });
	});
	it("refuses a date that is not a real YYYY-MM-DD, a missing value and a repeated flag", () => {
		for (const argv of [["--since", "2026-02-30"], ["--since", "60"], ["--since", "2026-9-1"], ["--since"], ["--since", "2026-09-10", "--since", "2026-09-11"], ["--goals", "  "]]) {
			assert.equal(parseCommand(["scan", ...argv]).kind, "error", argv.join(" "));
		}
	});
	it("an older item and one with an unreadable time are neither stored nor sent; newer items still go out", async () => {
		const r = rig({ items: [old, badTime, ...ALPHA] });
		assert.equal(await r.run("scan", "--since", "2026-10-01"), 0);
		for (const marker of ["ZQXOLDMARK", "ZQXBADTIME"]) {
			assert.equal(reached(r, marker), false, marker);
			assert.equal(dump(r.db).includes(marker), false, marker);
		}
		assert.ok(r.wire.some((w) => w.includes("alpha borrowing")), "items inside the limit still reach the judge");
		assert.ok(r.lines.includes("since 2026-10-01: 2 items older or without a session time not read in"));
	});
	it("the limit is inclusive to the millisecond: at the date goes out, one millisecond before does not", async () => {
		const at = raw("at1", "why does ZQXATMARK alpha fail", { at: "2026-10-01T00:00:00.000Z" });
		const before = raw("bf1", "why does ZQXBEFOREMARK alpha fail", { at: "2026-09-30T23:59:59.999Z" });
		const r = rig({ items: [at, before, ...ALPHA] });
		await r.run("scan", "--since", "2026-10-01");
		assert.equal(reached(r, "ZQXATMARK"), true);
		assert.equal(reached(r, "ZQXBEFOREMARK"), false);
	});
	it("an item with a recent write time but no or an old session time never reaches a wire", async () => {
		const derived = [
			raw("d1", "why does ZQXNOSESSION alpha fail", { source: "omp-memory", at: RECENT, sessionAt: null }),
			raw("d2", "why does ZQXOLDSESSION alpha fail", { source: "omp-recap", at: RECENT, sessionAt: OLD }),
		];
		const r = rig({ items: [...derived, ...ALPHA] });
		await r.run("scan", "--since", "2026-10-01");
		assert.equal(reached(r, "ZQXNOSESSION"), false);
		assert.equal(reached(r, "ZQXOLDSESSION"), false);
		assert.ok(r.wire.some((w) => w.includes("alpha borrowing")));
		const without = rig({ items: [...derived, ...ALPHA] });
		await without.run("scan");
		assert.equal(reached(without, "ZQXNOSESSION"), true, "no limit behaves as before");
	});
	it("Signet arc and epoch rollups reach neither the wire nor the store under --since; a session row does", async () => {
		// the real columns and kind values (Signet migration 029); a rollup's latest_at is recent although it spans older sessions
		const signet = () => {
			const db = openNodeSqlite(":memory:");
			db.exec("CREATE TABLE session_summaries (id TEXT PRIMARY KEY, project TEXT, depth INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL CHECK(kind IN ('session', 'arc', 'epoch')), content TEXT NOT NULL, token_count INTEGER, earliest_at TEXT NOT NULL, latest_at TEXT NOT NULL, session_key TEXT, harness TEXT, agent_id TEXT NOT NULL DEFAULT 'default', created_at TEXT NOT NULL); CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, updated_at TEXT NOT NULL, mentions INTEGER NOT NULL, status TEXT)");
			const row = (id: string, depth: number, kind: string, content: string) =>
				db.run("INSERT INTO session_summaries (id, project, depth, kind, content, earliest_at, latest_at, session_key, created_at) VALUES (?, '/work/app', ?, ?, ?, ?, ?, ?, ?)", id, depth, kind, content, OLD, RECENT, depth === 0 ? `k-${id}` : null, RECENT);
			row("s1", 0, "session", "why does ZQXSESSIONROW alpha fail");
			row("a1", 1, "arc", "why does ZQXARCROW alpha fail");
			row("e1", 2, "epoch", "why does ZQXEPOCHROW alpha fail");
			return signetSummarySource({ db: { all: async (sql, params = []) => db.all<Record<string, unknown>>(sql, ...params) }, minMentions: 50 });
		};
		const r = rig({ items: ALPHA });
		r.deps.sources = [...r.deps.sources, signet()];
		await r.run("scan", "--since", "2026-10-01");
		for (const marker of ["ZQXARCROW", "ZQXEPOCHROW"]) {
			assert.equal(reached(r, marker), false, marker);
			assert.equal(dump(r.db).includes(marker), false, marker);
		}
		assert.equal(reached(r, "ZQXSESSIONROW"), true, "a session-level row inside the limit still goes out");
		const without = rig({ items: ALPHA });
		without.deps.sources = [...without.deps.sources, signet()];
		await without.run("scan");
		assert.equal(reached(without, "ZQXARCROW"), true, "no limit behaves as before");
	});
	it("older items do not count toward a repeat that would make a newer item a candidate", async () => {
		// no confusion cue, so only a repeat across 3 sessions makes this text a candidate
		const same = "rename the ZQXREPEAT variable foo to bar";
		const items = [raw("r1", same, { at: OLD }), raw("r2", same, { at: OLD }), raw("r3", same), ...ALPHA];
		const r = rig({ items });
		await r.run("scan");
		assert.equal(reached(r, "ZQXREPEAT"), true, "without a limit the three make a repeat");
		r.wire.length = 0;
		r.prompts.length = 0;
		r.db.exec("DELETE FROM judgment_cache");
		await r.run("scan", "--since", "2026-10-01");
		assert.equal(reached(r, "ZQXREPEAT"), false);
	});
	it("an older item stored by an earlier run without a limit is not used by a run with one", async () => {
		const r = rig({ items: [old, ...ALPHA] });
		await r.run("scan");
		assert.equal(reached(r, "ZQXOLDMARK"), true, "no limit behaves as before: the older item goes out");
		r.wire.length = 0;
		r.prompts.length = 0;
		r.db.exec("DELETE FROM judgment_cache"); // a cache hit would hide what the second run sends
		await r.run("scan", "--since", "2026-10-01");
		assert.equal(reached(r, "ZQXOLDMARK"), false);
		assert.ok(r.wire.some((w) => w.includes("alpha borrowing")));
	});
});

describe("seeding extractor (lh-tw1.2)", () => {
	const CONFIG = new URL("../../scripts/seed-config.json", import.meta.url).pathname;
	it("seed-config.json names DeepSeek on Workers AI, and the app's catalog has that model", () => {
		const { extractor } = loadSeedConfig(CONFIG);
		assert.deepEqual(extractor, { provider: "cloudflare-workers-ai", id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017" });
		assert.ok(piModels().getModel(extractor.provider, extractor.id), "model missing from the pi-ai catalog");
	});
	const MODEL = { provider: "cloudflare-workers-ai", id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017" };
	const ENV = { CLOUDFLARE_API_KEY: "k", CLOUDFLARE_ACCOUNT_ID: "a" };
	it("with an extractor in seed-config.json, settings are never read", async () => {
		let read = 0;
		const llm = await realLlm(MODEL, { settingsExtractor: async () => (read++, { provider: "openai", id: "gpt-x" }), env: ENV });
		assert.equal(typeof llm.complete, "function");
		assert.equal(read, 0);
	});
	it("without one, settings are read and an empty role refuses", async () => {
		let read = 0;
		await assert.rejects(realLlm(undefined, { settingsExtractor: async () => (read++, undefined), env: ENV }), (e) => e instanceof LlmUnavailableError && /no model is configured/.test(e.message));
		assert.equal(read, 1);
	});
	it("a model missing from the catalog, a missing key or a missing account refuses before any send", async () => {
		const none = async () => undefined;
		await assert.rejects(realLlm({ ...MODEL, id: "@cf/none/nope" }, { settingsExtractor: none, env: ENV }), /is not in the model catalog/);
		await assert.rejects(realLlm(MODEL, { settingsExtractor: none, env: { CLOUDFLARE_ACCOUNT_ID: "a" } }), /no API key for cloudflare-workers-ai/);
		await assert.rejects(realLlm(MODEL, { settingsExtractor: none, env: { CLOUDFLARE_API_KEY: "k" } }), /needs CLOUDFLARE_ACCOUNT_ID/);
	});
	it("main stops a scan before sources or the network when the judge's variables or the extractor are missing", async () => {
		for (const [env, buildLlm, expected] of [
			[() => undefined, async () => ({ complete: async () => ({}) as never }), "scan stopped before sending anything: the clef judge needs JEV_CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID in the environment"],
			[() => "x", async () => Promise.reject(new LlmUnavailableError("no API key for cloudflare-workers-ai in the environment")), "scan stopped before sending anything: no API key for cloudflare-workers-ai in the environment"],
		] as const) {
			const calls: string[] = [];
			const lines: string[] = [];
			const code = await main(["scan"], {
				dataDir: "/nonexistent-data-dir",
				lhVersion: () => "t",
				openStore: () => openNodeSqlite(":memory:"),
				readOptOut: async () => [],
				buildSources: () => (calls.push("sources"), { sources: [], close() {} }),
				buildLlm,
				env,
				fetch: (async () => (calls.push("fetch"), new Response("{}"))) as unknown as typeof fetch,
				out: (l) => lines.push(l),
			});
			assert.equal(code, 1);
			assert.ok(lines.includes(expected), lines.join(" | "));
			assert.deepEqual(calls, []);
		}
	});
	it("a malformed extractor refuses", () => {
		const base = { calibrated: false, recencyHalfLifeDays: 60, goalWeight: 1, minMentions: 50, learnableTau: 0.5 };
		for (const extractor of [{ provider: "x", id: "" }, { id: "m" }, { provider: "x", id: "m", extra: 1 }, "x/m"]) {
			assert.throws(() => loadSeedConfig("/c.json", () => JSON.stringify({ ...base, extractor })), /invalid/, JSON.stringify(extractor));
		}
	});
	async function scanWith(config: Record<string, unknown>) {
		const dir = mkdtempSync(join(tmpdir(), "seed-extractor-"));
		try {
			writeFileSync(join(dir, "seed-config.json"), JSON.stringify(config));
			const lines: string[] = [];
			const got: unknown[] = [];
			const src: SessionSource = { name: "fake", stats: { skipped: 0 }, async *items() { yield raw("a1", "why does alpha borrowing fail"); } };
			await main(["scan", "--judge", "configured-llm"], {
				dataDir: dir,
				configFile: join(dir, "seed-config.json"),
				lhVersion: () => "t",
				openStore: () => openNodeSqlite(":memory:"),
				buildSources: () => ({ sources: [src], close() {} }),
				buildLlm: async (extractor) => (got.push(extractor), { complete: async () => Promise.reject(new Error("no model")) }),
				env: () => undefined,
				fetch: (async () => Promise.reject(new Error("no network"))) as unknown as typeof fetch,
				out: (l) => lines.push(l),
			}).catch(() => -1);
			return { lines, got };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	const base = { calibrated: true, recencyHalfLifeDays: 60, goalWeight: 1, minMentions: 50, learnableTau: 0.5 };
	it("the configured extractor reaches the LLM factory and is named before anything leaves", async () => {
		const { lines, got } = await scanWith({ ...base, extractor: { provider: "cloudflare-workers-ai", id: "m-1" } });
		assert.deepEqual(got, [{ provider: "cloudflare-workers-ai", id: "m-1" }]);
		assert.ok(lines.includes("extractor: cloudflare-workers-ai/m-1 from seed-config.json"));
	});
	it("without one, the factory gets nothing and falls back to the app's extractor role", async () => {
		const { lines, got } = await scanWith(base);
		assert.deepEqual(got, [undefined]);
		assert.ok(lines.includes("extractor: the app's extractor role from settings"));
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

describe("propose: every evidence item must be allowed to leave", () => {
	const items = [raw("a1", "why does alpha ZQXOK fail", { project: "/work/ok" }), raw("a2", "why is alpha ZQXBLOCKED odd", { project: "/work/blocked", at: "2026-10-01T00:00:00.000Z" })];
	it("an opt-out added after the scan skips the proposal: no POST, no accept, status unchanged", async () => {
		for (const entry of ["blocked", "ok"]) {
			const { r, p } = await labelled({ items });
			r.deps.allowEgress = composeAllowEgress([entry]);
			assert.equal(await r.run("propose"), 0);
			assert.equal(r.chat.calls.length, 0, entry);
			assert.equal(r.store.accepts().length, 0);
			assert.equal(r.store.loadProposals().find((x) => x.id === p.id)!.status, "proposed");
			assert.ok(r.lines.some((l) => l.startsWith(`skipped ${p.id}: some of its evidence is opted out`)));
		}
	});
	it("with nothing opted out the same proposal is posted, with the first message from the oldest evidence", async () => {
		const { r } = await labelled({ items });
		r.deps.allowEgress = composeAllowEgress(["unrelated"]);
		await r.run("propose");
		assert.equal(r.chat.calls.length, 1);
		assert.ok(r.store.accepts()[0]!.firstMessage.includes("ZQXBLOCKED"));
	});
});

describe("topic prompt clips every snippet (lh-j2c)", () => {
	it("items longer than the cap reach the topic prompt at exactly 300 characters", async () => {
		const long = (n: string) => raw(n, `why does alpha borrowing fail ${"word ".repeat(200)}`);
		const r = rig({ items: [long("l1"), long("l2")] });
		await r.run("scan");
		const topic = r.prompts.find((p) => p.startsWith("Name the distinct teachable topics"))!;
		const snippets = topic.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
		assert.equal(snippets.length, 2);
		for (const line of snippets) assert.equal(line.length, 300);
	});
});

describe("model-written title and why are redacted on write (lh-j2c)", () => {
	it("a planted secret and home path in the draft reach no table column", async () => {
		const r = rig({ items: ALPHA });
		r.knobs.draft = { title: `Alpha ${SECRET}`, why: `see /Users/bob/notes and ${SECRET}` };
		await r.run("scan");
		assert.equal(r.store.loadProposals().length, 1);
		const d = dump(r.db);
		assert.equal(d.includes("ZZZZ1111YYYY2222XXXX3333"), false);
		assert.equal(d.includes("/Users/bob"), false);
		assert.ok(d.includes("Alpha [redacted:secret]"));
	});
});
