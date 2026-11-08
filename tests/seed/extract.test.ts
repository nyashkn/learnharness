import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { createAllowEgress, MAX_SNIPPET_CHARS } from "../../src/seed/egress";
import { DraftSchema, extractDraft, type ProposalDraft } from "../../src/seed/extract";
import { type Aligner, type Alignment, mergeDrafts, type Proposal } from "../../src/seed/proposals";
import type { HarvestItem, LlmPort } from "../../src/seed/types";

// ---- fakes ------------------------------------------------------------------

function fakeLlm(respond: (prompt: string) => unknown) {
	const prompts: string[] = [];
	const schemas: unknown[] = [];
	const llm: LlmPort = {
		async complete(prompt, schema) {
			prompts.push(prompt);
			schemas.push(schema);
			return respond(prompt) as never;
		},
	};
	return { llm, prompts, schemas };
}

function hItem(id: string, over: Partial<HarvestItem> = {}): HarvestItem {
	return { id, source: "claude-history", project: null, sessionId: null, at: "2030-01-01T00:00:00.000Z", signal: null, textRedacted: `text ${id}`, ...over };
}

const good = (over: Partial<ProposalDraft> = {}): ProposalDraft => ({ title: "Binary search", why: "keeps coming up", kind: "concept", evidenceIds: ["a"], ...over });
const NOW = "2031-06-01T00:00:00.000Z";

function idGen(prefix = "p") {
	let n = 0;
	return () => `${prefix}${++n}`;
}

function prop(id: string, over: Partial<Proposal> = {}): Proposal {
	return {
		id, title: "Binary search", why: "w", kind: "concept", prereqOf: null, firstSeen: "2030-01-01T00:00:00.000Z",
		lastSeen: "2030-01-01T00:00:00.000Z", nItems: 1, nProjects: 0, rankScore: null, status: "proposed", mergedInto: null,
		evidenceIds: ["a"], ...over,
	};
}

const scripted = (byId: Record<string, Alignment>): { align: Aligner; calls: string[] } => {
	const calls: string[] = [];
	return { calls, align: async (existing) => { calls.push(existing.id); return byId[existing.id] ?? "different"; } };
};

const merge = (existing: Proposal[], drafts: ProposalDraft[], align: Aligner, items: HarvestItem[] = [], newId = idGen("new")) =>
	mergeDrafts({ existing, drafts, items: new Map(items.map((i) => [i.id, i])), align, newId, now: () => NOW });

// ---- extractDraft -----------------------------------------------------------

describe("extractDraft: egress (K-D6)", () => {
	const optOut = createAllowEgress(["blocked"]);

	it("an opted-out item's text never reaches the prompt; project names and session ids never do either", async () => {
		const itemArb = fc.record({ blocked: fc.boolean(), nullProject: fc.boolean(), body: fc.stringMatching(/^[a-z ]{0,400}$/) });
		await fc.assert(fc.asyncProperty(fc.array(itemArb, { minLength: 1, maxLength: 6 }), async (specs) => {
			const items = specs.map((s, i) => hItem(`id${i}`, {
				project: s.nullProject ? null : `${s.blocked ? "blocked" : "open"}-proj-${i}`,
				sessionId: `sess-${i}`,
				textRedacted: `MARK${i} ${s.body}`,
			}));
			const { llm, prompts } = fakeLlm(() => good({ evidenceIds: items.map((i) => i.id) }));
			const res = await extractDraft(items, { llm, allowEgress: optOut });
			const allowed = items.filter((i) => optOut(i.project));
			if (allowed.length === 0) {
				assert.deepEqual(res, { kind: "skipped", reason: "egress-denied" });
				assert.equal(prompts.length, 0);
				return;
			}
			const prompt = prompts[0] as string;
			for (const [i, it] of items.entries()) {
				assert.equal(prompt.includes(`MARK${i}`), optOut(it.project), `item ${i}`);
				assert.ok(!prompt.includes(`sess-${i}`));
				assert.ok(!prompt.includes(`proj-${i}`));
			}
			assert.ok(res.kind === "draft");
			assert.deepEqual(res.draft.evidenceIds, allowed.map((i) => i.id));
		}));
	});

	it("all opted out means zero LLM calls", async () => {
		const { llm, prompts } = fakeLlm(() => good());
		const res = await extractDraft([hItem("a", { project: "blocked-x" }), hItem("b", { project: "BLOCKED-y" })], { llm, allowEgress: optOut });
		assert.deepEqual(res, { kind: "skipped", reason: "egress-denied" });
		assert.equal(prompts.length, 0);
	});

	it("allowEgress is called with every item's project", async () => {
		const seen: (string | null)[] = [];
		const { llm } = fakeLlm(() => good());
		await extractDraft([hItem("a", { project: "x" }), hItem("b", { project: null }), hItem("c", { project: "y" })], { llm, allowEgress: (p) => { seen.push(p); return true; } });
		assert.deepEqual(seen, ["x", null, "y"]);
	});

	it("snippets are clipped to 300 chars", async () => {
		const { llm, prompts } = fakeLlm(() => good());
		await extractDraft([hItem("a", { textRedacted: `${"a".repeat(MAX_SNIPPET_CHARS)}TAILMARK` })], { llm, allowEgress: () => true });
		assert.ok(!(prompts[0] as string).includes("TAILMARK"));
		assert.ok((prompts[0] as string).includes("a".repeat(MAX_SNIPPET_CHARS)));
	});
});

describe("extractDraft: LLM output is a trust boundary", () => {
	const run = (respond: () => unknown) => {
		const f = fakeLlm(respond);
		return extractDraft([hItem("a"), hItem("b")], { llm: f.llm, allowEgress: () => true }).then((res) => ({ res, ...f }));
	};

	it("a valid answer becomes a draft and the schema is passed to the port", async () => {
		const { res, schemas } = await run(() => good({ evidenceIds: ["a", "b", "a"] }));
		assert.deepEqual(res, { kind: "draft", draft: good({ evidenceIds: ["a", "b"] }) });
		assert.equal(schemas[0], DraftSchema);
	});

	it("a thrown call is llm-failed", async () => {
		const { res } = await run(() => { throw new Error("boom"); });
		assert.deepEqual(res, { kind: "skipped", reason: "llm-failed" });
	});

	for (const [name, out] of Object.entries({
		"null": null,
		"a string": "nope",
		"missing why": { title: "t", kind: "concept", evidenceIds: ["a"] },
		"unknown kind": good({ kind: "idea" as never }),
		"non-string title": { ...good(), title: 3 },
		"evidence not an array": { ...good(), evidenceIds: "a" },
		"blank title": good({ title: "  \t" }),
		"blank why": good({ why: "" }),
		"only hallucinated evidence": good({ evidenceIds: ["zzz"] }),
		"no evidence": good({ evidenceIds: [] }),
	})) {
		it(`${name} is invalid-output`, async () => {
			const { res } = await run(() => out);
			assert.deepEqual(res, { kind: "skipped", reason: "invalid-output" });
		});
	}

	it("hallucinated evidence ids are dropped, real ones kept", async () => {
		const { res } = await run(() => good({ evidenceIds: ["zzz", "b"] }));
		assert.ok(res.kind === "draft");
		assert.deepEqual(res.draft.evidenceIds, ["b"]);
	});

	it("an id from an opted-out item counts as hallucinated", async () => {
		const f = fakeLlm(() => good({ evidenceIds: ["secret", "a"] }));
		const res = await extractDraft([hItem("a"), hItem("secret", { project: "blocked-x" })], { llm: f.llm, allowEgress: createAllowEgress(["blocked"]) });
		assert.ok(res.kind === "draft");
		assert.deepEqual(res.draft.evidenceIds, ["a"]);
	});
});

// ---- mergeDrafts: each alignment ---------------------------------------------

describe("mergeDrafts: alignment outcomes", () => {
	const items = [
		hItem("a", { project: "p0", at: "2030-01-05T00:00:00.000Z" }),
		hItem("b", { project: "p1", at: "2030-01-02T00:00:00.000Z" }),
		hItem("c", { project: "p0", at: "2030-01-09T00:00:00.000Z" }),
	];

	it("same: merges into the existing proposal, keeps its identity fields, unions evidence, recomputes counters", async () => {
		const old = prop("old", { title: "Keep me", why: "keep", kind: "tool", status: "accepted", rankScore: 0.5, prereqOf: "x", firstSeen: "2030-01-05T00:00:00.000Z", lastSeen: "2030-01-05T00:00:00.000Z" });
		const { align } = scripted({ old: "same" });
		const out = await merge([old], [good({ title: "Different words", why: "new why", kind: "skill", evidenceIds: ["a", "b", "c"] })], align, items);
		assert.equal(out.proposals.length, 1);
		assert.deepEqual(out.proposals[0], {
			...old, evidenceIds: ["a", "b", "c"], nItems: 3, nProjects: 2,
			firstSeen: "2030-01-02T00:00:00.000Z", lastSeen: "2030-01-09T00:00:00.000Z",
		});
		assert.deepEqual(out.reviews, []);
	});

	it("same into the oldest of several; the others get multiple-same reviews and stay untouched", async () => {
		const young = prop("a-young", { firstSeen: "2030-03-01T00:00:00.000Z" });
		const oldest = prop("z-oldest", { firstSeen: "2029-01-01T00:00:00.000Z" });
		const mid = prop("m-mid", { firstSeen: "2030-02-01T00:00:00.000Z" });
		const { align } = scripted({ "a-young": "same", "z-oldest": "same", "m-mid": "same" });
		const out = await merge([young, oldest, mid], [good({ evidenceIds: ["a", "b"] })], align, items);
		assert.equal(out.proposals.length, 3);
		assert.deepEqual(out.proposals.find((p) => p.id === "z-oldest")?.evidenceIds, ["a", "b"]);
		assert.deepEqual(out.proposals.find((p) => p.id === "a-young"), young);
		assert.deepEqual(out.proposals.find((p) => p.id === "m-mid"), mid);
		assert.deepEqual(out.reviews.map((r) => [r.reason, r.existingId]).sort(), [["multiple-same", "a-young"], ["multiple-same", "m-mid"]]);
	});

	it("related: appends a new proposal and flags a review; never merges", async () => {
		const old = prop("old");
		const { align } = scripted({ old: "related" });
		const out = await merge([old], [good({ evidenceIds: ["b"] })], align, items);
		assert.deepEqual(out.proposals[0], old);
		assert.equal(out.proposals.length, 2);
		assert.equal(out.proposals[1]?.id, "new1");
		assert.deepEqual(out.proposals[1]?.evidenceIds, ["b"]);
		assert.deepEqual(out.reviews, [{ draftTitle: "Binary search", existingId: "old", reason: "related" }]);
	});

	it("different: appends with a fresh id, status proposed, nulls", async () => {
		const out = await merge([prop("old")], [good({ title: "Binary search again", evidenceIds: ["b"] })], scripted({}).align, items);
		assert.equal(out.proposals.length, 2);
		assert.deepEqual(out.proposals[1], {
			id: "new1", title: "Binary search again", why: "keeps coming up", kind: "concept", prereqOf: null,
			firstSeen: "2030-01-02T00:00:00.000Z", lastSeen: "2030-01-02T00:00:00.000Z", nItems: 1, nProjects: 1,
			rankScore: null, status: "proposed", mergedInto: null, evidenceIds: ["b"],
		});
		assert.deepEqual(out.reviews, []);
	});

	it("review: fails closed, neither appends nor merges, flags undecided", async () => {
		const old = prop("old");
		const out = await merge([old], [good({ evidenceIds: ["b"] })], scripted({ old: "review" }).align, items);
		assert.deepEqual(out.proposals, [old]);
		assert.deepEqual(out.reviews, [{ draftTitle: "Binary search", existingId: "old", reason: "undecided" }]);
	});

	it("review beats related when no candidate is same", async () => {
		const out = await merge([prop("r1"), prop("r2")], [good({ evidenceIds: ["b"] })], scripted({ r1: "related", r2: "review" }).align, items);
		assert.equal(out.proposals.length, 2);
		assert.deepEqual(out.reviews.map((r) => r.reason), ["undecided"]);
	});

	it("same beats review and related", async () => {
		const out = await merge([prop("r1"), prop("r2"), prop("s1")], [good({ evidenceIds: ["b"] })], scripted({ r1: "related", r2: "review", s1: "same" }).align, items);
		assert.equal(out.proposals.length, 3);
		assert.deepEqual(out.proposals.find((p) => p.id === "s1")?.evidenceIds, ["a", "b"]);
	});

	it("merged proposals are never candidates", async () => {
		const { align, calls } = scripted({ gone: "same" });
		const out = await merge([prop("gone", { status: "merged", mergedInto: "x" })], [good()], align, items);
		assert.deepEqual(calls, []);
		assert.equal(out.proposals.length, 2);
	});

	it("shortlist: no shared evidence and no shared title token means no aligner call and a new proposal", async () => {
		const { align, calls } = scripted({ old: "same" });
		const out = await merge([prop("old", { title: "Binary search", evidenceIds: ["a"] })], [good({ title: "The graph colouring", evidenceIds: ["b"] })], align, items);
		assert.deepEqual(calls, []);
		assert.equal(out.proposals.length, 2);
	});

	it("shortlist: stop words alone do not qualify", async () => {
		const { calls, align } = scripted({});
		await merge([prop("old", { title: "The how of the", evidenceIds: ["a"] })], [good({ title: "of the and", evidenceIds: ["b"] })], align, items);
		assert.deepEqual(calls, []);
	});

	it("shortlist: a shared title token qualifies, case-insensitively", async () => {
		const { calls, align } = scripted({});
		await merge([prop("old", { title: "BINARY trees", evidenceIds: ["a"] })], [good({ title: "binary heaps", evidenceIds: ["b"] })], align, items);
		assert.deepEqual(calls, ["old"]);
	});

	it("regression: a reworded title with overlapping evidence still reaches the aligner and keeps the id", async () => {
		const old = prop("stable", { title: "Binary search", evidenceIds: ["a", "b"] });
		const { align, calls } = scripted({ stable: "same" });
		const out = await merge([old], [good({ title: "Halving a sorted array", evidenceIds: ["a"] })], align, items);
		assert.deepEqual(calls, ["stable"]);
		assert.equal(out.proposals.length, 1);
		assert.equal(out.proposals[0]?.id, "stable");
		assert.equal(out.proposals[0]?.title, "Binary search");
	});

	it("a draft aligns against proposals appended earlier in the same run", async () => {
		const { calls, align } = scripted({ new1: "same" });
		const out = await merge([], [good({ evidenceIds: ["a"] }), good({ title: "Search tricks", evidenceIds: ["a", "b"] })], align, items);
		assert.deepEqual(calls, ["new1"]);
		assert.equal(out.proposals.length, 1);
		assert.deepEqual(out.proposals[0]?.evidenceIds, ["a", "b"]);
	});

	it("counters never decrease when source retention pruned the items; evidence ids are kept", async () => {
		const old = prop("old", { nProjects: 3, nItems: 2, evidenceIds: ["gone1", "gone2"], firstSeen: "2029-01-01T00:00:00.000Z", lastSeen: "2031-01-01T00:00:00.000Z" });
		const out = await merge([old], [good({ evidenceIds: ["gone1"] })], scripted({ old: "same" }).align, []);
		assert.deepEqual(out.proposals, [old]);
	});

	it("a new draft with no visible evidence is stamped with now()", async () => {
		const out = await merge([], [good({ evidenceIds: ["unseen"] })], scripted({}).align, []);
		assert.equal(out.proposals[0]?.firstSeen, NOW);
		assert.equal(out.proposals[0]?.lastSeen, NOW);
		assert.equal(out.proposals[0]?.nProjects, 0);
	});

	it("does not mutate its inputs", async () => {
		const existing = [prop("old")];
		const before = structuredClone(existing);
		await merge(existing, [good({ evidenceIds: ["a", "b"] })], scripted({ old: "same" }).align, items);
		assert.deepEqual(existing, before);
	});

	it("re-running the same drafts with exact-match same adds nothing and keeps ids", async () => {
		const draftArb = fc.record({
			title: fc.constantFrom("Binary search", "Graph colouring", "Binary trees", "Hash maps"),
			why: fc.constant("w"),
			kind: fc.constantFrom("concept", "skill", "tool", "pattern"),
			evidenceIds: fc.uniqueArray(fc.constantFrom("a", "b", "c"), { minLength: 1, maxLength: 3 }),
		}) as fc.Arbitrary<ProposalDraft>;
		await fc.assert(fc.asyncProperty(fc.array(draftArb, { maxLength: 5 }), async (drafts) => {
			const first = await merge([], drafts, scripted({}).align, items);
			const exact: Aligner = async (e, d) => (e.title === d.title && [...e.evidenceIds].sort().join() === [...d.evidenceIds].sort().join() ? "same" : "different");
			const second = await merge(first.proposals, drafts, exact, items);
			assert.deepEqual(second.proposals, first.proposals);
		}));
	});
});

// ---- model-based rescans ------------------------------------------------------

const POOL = [
	{ id: "i0", project: "p0" }, { id: "i1", project: "p1" }, { id: "i2", project: null },
	{ id: "i3", project: "p0" }, { id: "i4", project: "p2" }, { id: "i5", project: null },
].map((x, n) => hItem(x.id, { project: x.project, at: `2030-01-0${n + 1}T00:00:00.000Z` }));

const WORDS = ["binary", "search", "graph", "hash", "tree", "sort"];

interface Real { proposals: Proposal[]; next: number }
interface Model { snapshot: Proposal[]; issued: Set<string>; labels: Map<string, "learn" | "know" | "skip"> }

const draftArb: fc.Arbitrary<ProposalDraft> = fc.record({
	title: fc.uniqueArray(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 3 }).map((w) => w.join(" ")),
	why: fc.constant("because"),
	kind: fc.constantFrom("concept", "skill", "tool", "pattern"),
	evidenceIds: fc.uniqueArray(fc.constantFrom(...POOL.map((i) => i.id)), { minLength: 1, maxLength: 3 }),
});

class Rescan implements fc.AsyncCommand<Model, Real> {
	constructor(readonly drafts: ProposalDraft[], readonly answers: Alignment[], readonly visible: boolean[]) {}
	check = () => true;
	async run(m: Model, r: Real) {
		const queue = [...this.answers];
		const items = new Map(POOL.filter((_, i) => this.visible[i]).map((i) => [i.id, i]));
		const out = await mergeDrafts({
			existing: r.proposals, drafts: this.drafts, items,
			align: async () => queue.shift() ?? "different",
			newId: () => { r.next += 1; return `n${r.next}`; },
			now: () => NOW,
		});
		const after = new Map(out.proposals.map((p) => [p.id, p]));
		assert.equal(after.size, out.proposals.length, "ids unique");
		for (const old of m.snapshot) {
			const p = after.get(old.id);
			assert.ok(p, `id ${old.id} survived`);
			assert.ok(old.evidenceIds.every((e) => p.evidenceIds.includes(e)), "evidence only grows");
			assert.deepEqual([p.title, p.why, p.kind, p.status, p.prereqOf, p.mergedInto, p.rankScore], [old.title, old.why, old.kind, old.status, old.prereqOf, old.mergedInto, old.rankScore]);
			assert.ok(p.nProjects >= old.nProjects && p.firstSeen <= old.firstSeen && p.lastSeen >= old.lastSeen, "counters monotone");
		}
		for (const p of out.proposals) {
			assert.equal(p.nItems, p.evidenceIds.length);
			assert.equal(new Set(p.evidenceIds).size, p.evidenceIds.length);
		}
		for (const id of m.issued) assert.ok(after.has(id), `issued ${id} survived`);
		for (const id of m.labels.keys()) assert.ok(after.has(id), `labelled ${id} resolves`);
		assert.ok(out.proposals.length - m.snapshot.length <= this.drafts.length, "at most one append per draft");
		r.proposals = out.proposals;
		m.snapshot = structuredClone(out.proposals);
		for (const p of out.proposals) m.issued.add(p.id);
	}
	toString = () => `rescan(${JSON.stringify(this.drafts.map((d) => `${d.title}:${d.evidenceIds}`))}, ${this.answers}, ${this.visible.map(Number).join("")})`;
}

class AddLabel implements fc.AsyncCommand<Model, Real> {
	constructor(readonly pick: number, readonly verdict: "learn" | "know" | "skip") {}
	check = (m: Model) => m.snapshot.length > 0;
	async run(m: Model) {
		const id = (m.snapshot[this.pick % m.snapshot.length] as Proposal).id;
		if (!m.labels.has(id)) m.labels.set(id, this.verdict);
	}
	toString = () => `label(${this.pick}, ${this.verdict})`;
}

describe("mergeDrafts: model-based rescan sequences", () => {
	const cmds = fc.commands([
		fc.tuple(fc.array(draftArb, { maxLength: 4 }), fc.array(fc.constantFrom<Alignment>("same", "related", "different", "review"), { maxLength: 12 }), fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }))
			.map(([d, a, v]) => new Rescan(d, a, v)),
		fc.tuple(fc.nat(20), fc.constantFrom<"learn" | "know" | "skip">("learn", "know", "skip")).map(([p, v]) => new AddLabel(p, v)),
	], { maxCommands: 15 });

	it("ids, labels, evidence and counters hold across any rescan sequence", async () => {
		await fc.assert(fc.asyncProperty(cmds, async (c) => {
			await fc.asyncModelRun(() => ({ model: { snapshot: [], issued: new Set<string>(), labels: new Map() }, real: { proposals: [], next: 0 } }), c);
		}), { numRuns: 200 });
	});
});
