/**
 * The storage contract, as properties. Categories (see MATRIX.md):
 *  A fold semantics   B append/read round-trip   C rewriteLedgers   D transact atomicity
 *  E coverage ledger  F simplify/merge invariants G format guard     H record round-trips
 *  I ordering/identity J cross-adapter equivalence
 * Test names start with their id (A1, B3 ...). Tests whose failure is a confirmed
 * gap of one adapter are in KNOWN_GAPS and run as node:test `todo` (they still execute and report).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it, mock, test } from "node:test";
import fc from "fast-check";
import * as A from "./harness.ts";
import { discoverAdapters, openFresh, reopen } from "./harness.ts";
import type { AdapterFactory, AnyLedger, Ledger, StoreBundle } from "./harness.ts";
import { getGraph, mergeFindings, simplifyChains } from "../../src/core/graph.ts";
import { coveredSet } from "../../src/core/coverage.ts";
import type { CoverageEntry, GraphChain, GraphNode, ReviewLine, SessionCheckpoint } from "../../src/core/contracts.ts";
import type { GraphStore } from "../../src/core/ports.ts";

/** adapter name -> test id -> owning bead. Runs as node:test `todo` for THAT adapter only: the test executes and reports but does not fail the run. A different adapter gets no allowance. */
const KNOWN_GAPS: Record<string, Record<string, string>> = {};


// ── tiny oracle pieces (deliberately written differently from graph.ts) ──────
const key = (p: readonly string[], c: string) => JSON.stringify([[...p].sort(), c]);
const ptKey = (p: { chatId: string; messageId: string }) => `${p.chatId}\u0000${p.messageId}`;
function oracleNodes(lines: GraphNode[]): GraphNode[] {
	const out = new Map<string, GraphNode>();
	for (const l of lines) {
		const cur = out.get(l.id);
		if (!cur) { out.set(l.id, structuredClone(l)); continue; }
		const al = [...cur.aliases];
		for (const s of [l.statement, ...l.aliases]) if (s !== "" && !al.includes(s)) al.push(s);
		const seen = new Set(cur.provenance.map(ptKey));
		const pv = [...cur.provenance];
		for (const p of l.provenance) if (!seen.has(ptKey(p))) { seen.add(ptKey(p)); pv.push(p); }
		out.set(l.id, { ...cur, aliases: al, provenance: pv });
	}
	return [...out.values()];
}
function oracleChains(lines: GraphChain[]): GraphChain[] {
	const out = new Map<string, GraphChain>();
	for (const l of lines) {
		const k = key(l.premises, l.conclusion);
		const cur = out.get(k);
		if (!cur) { out.set(k, structuredClone(l)); continue; }
		const seen = new Set(cur.provenance.map(ptKey));
		for (const p of l.provenance) if (!seen.has(ptKey(p))) { seen.add(ptKey(p)); cur.provenance.push(p); }
	}
	return [...out.values()];
}
const closure = (start: readonly string[], chains: GraphChain[]): Set<string> => {
	const s = new Set(start);
	for (let grew = true; grew; ) {
		grew = false;
		for (const c of chains) if (!s.has(c.conclusion) && c.premises.every((p) => s.has(p))) { s.add(c.conclusion); grew = true; }
	}
	return s;
};
const state = (g: GraphStore) => JSON.stringify([g.readNodes(), g.readChains(), g.readCoverage(), g.readCheckpoints()]);
/** Plain-object deep equality (fast-check may emit null-prototype records). */
const eq = (a: unknown, b: unknown) => assert.deepStrictEqual(structuredClone(a), structuredClone(b));

export function registerContract(f: AdapterFactory): void {
	const fresh = (): Promise<StoreBundle> => openFresh(f);
	const gaps = KNOWN_GAPS[f.name] ?? {};
	/** `todo`: bead id while the API under test is absent (the body still runs and reports). Known gaps of this adapter get the same treatment. */
	const P = <T>(id: string, title: string, arb: fc.Arbitrary<T>, fn: (b: StoreBundle, v: T) => void | Promise<void>, opts: { skip?: string; todo?: string; runs?: number } = {}) => {
		const name = `${id} ${title}`;
		const bead = opts.todo ?? gaps[id];
		const limit = f.propertyTimeoutMs ?? A.PROPERTY_TIMEOUT_MS; // shortcut: one limit per adapter, not per test; split it if a second slow test appears
		const o = { timeout: limit, ...(opts.skip ? { skip: opts.skip } : bead ? { todo: bead } : {}) };
		it(name, o, () => fc.assert(fc.asyncProperty(arb, async (v) => { const b = await fresh(); try { await fn(b, v); } finally { b.dispose(); } }), { ...A.cfg, numRuns: opts.runs ?? A.cfg.numRuns, interruptAfterTimeLimit: limit - 20_000 }));
	};
	const T = (id: string, title: string, fn: (b: StoreBundle) => void, opts?: { runs?: number }) => P(id, title, fc.constant(0), (b) => fn(b), opts);

	const putAll = (b: StoreBundle, nodes: GraphNode[] = [], chains: GraphChain[] = []) => {
		nodes.forEach((n) => b.graph.appendNode(n));
		chains.forEach((c) => b.graph.appendChain(c));
	};

	describe(`${f.name}: A fold semantics`, () => {
		const lines = fc.array(A.nodeLine, { maxLength: 12 });
		P("A1", "first line for an id defines name/statement/createdAt", lines, (b, ls) => {
			putAll(b, ls);
			for (const n of getGraph(b.graph).nodes) {
				const first = ls.find((l) => l.id === n.id)!;
				eq([n.name, n.statement, n.createdAt], [first.name, first.statement, first.createdAt]);
			}
		});
		P("A2", "aliases = first aliases + later phrasings (statement, aliases), non-empty, exact-string deduped", lines, (b, ls) => {
			putAll(b, ls);
			eq(getGraph(b.graph).nodes.map((n) => n.aliases), oracleNodes(ls).map((n) => n.aliases));
		});
		P("A3", "provenance unions by (chatId,messageId) in encounter order", lines, (b, ls) => {
			putAll(b, ls);
			eq(getGraph(b.graph).nodes.map((n) => n.provenance), oracleNodes(ls).map((n) => n.provenance));
			for (const n of getGraph(b.graph).nodes) for (const l of ls.filter((x) => x.id === n.id)) for (const p of l.provenance) assert.ok(n.provenance.some((q) => ptKey(q) === ptKey(p)), "lost a provenance point");
		});
		P("A4", "chain lines merge by sorted premises + conclusion; first line's id/premises/createdAt stand; provenance unions", fc.array(A.chainLine, { maxLength: 10 }), (b, ls) => {
			putAll(b, [], ls);
			eq(getGraph(b.graph).chains, oracleChains(ls));
		});
		P("A5", "premise ORDER within a line does not change the chain key", fc.array(A.chainLine, { maxLength: 8 }), (b, ls) => {
			putAll(b, [], ls.map((l) => ({ ...l, premises: [...l.premises].reverse() })));
			eq(getGraph(b.graph).chains.length, new Set(ls.map((l) => key(l.premises, l.conclusion))).size);
		});
		P("A6", "lines of different ids commute: per-id fold is independent of cross-id interleaving", fc.tuple(lines, fc.infiniteStream(fc.nat(1000))), async (b, [ls, rnd]) => {
			const ids = [...new Set(ls.map((l) => l.id))];
			const it2 = rnd[Symbol.iterator]();
			const order = ids.map((id) => [id, it2.next().value as number] as const).sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0])).map((x) => x[0]);
			const regrouped = order.flatMap((id) => ls.filter((l) => l.id === id));
			putAll(b, ls);
			const base = new Map(getGraph(b.graph).nodes.map((n) => [n.id, n]));
			const b2 = await fresh();
			try { putAll(b2, regrouped); for (const n of getGraph(b2.graph).nodes) eq(n, base.get(n.id)); } finally { b2.dispose(); }
		});
		P("A7", "fold is deterministic and does not mutate the ledger", lines, (b, ls) => {
			putAll(b, ls);
			const s0 = state(b.graph);
			eq(getGraph(b.graph), getGraph(b.graph));
			eq(state(b.graph), s0);
		});
	});

	describe(`${f.name}: B append/read round-trip`, () => {
		const ledgers: { l: AnyLedger; arb: fc.Arbitrary<unknown>; app: (b: StoreBundle, v: any) => void; rd: (b: StoreBundle) => unknown[] }[] = [
			{ l: "nodes", arb: A.verbatimNode, app: (b, v) => b.graph.appendNode(v), rd: (b) => b.graph.readNodes() },
			{ l: "chains", arb: A.verbatimChain, app: (b, v) => b.graph.appendChain(v), rd: (b) => b.graph.readChains() },
			{ l: "reviews", arb: A.verbatimReview, app: (b, v) => b.graph.appendReview(v), rd: (b) => b.graph.readReviews() },
			{ l: "checkpoints", arb: A.verbatimCheckpoint, app: (b, v) => b.graph.appendCheckpoint(v), rd: (b) => b.graph.readCheckpoints() },
		];
		for (const L of ledgers) {
			const lines = fc.array(L.arb, { maxLength: 10 });
			P(`B1-${L.l}`, "append then read returns the same lines in append order", lines, (b, ls) => { ls.forEach((v) => L.app(b, v)); eq(L.rd(b), ls); assert.equal(JSON.stringify(L.rd(b)), JSON.stringify(ls), "verbatim: unknown fields, whitespace and key order must survive"); });
			P(`B2-${L.l}`, "duplicate lines survive as a multiset (k copies in, k copies out)", fc.tuple(L.arb, fc.integer({ min: 1, max: 5 })), (b, [v, k]) => { for (let i = 0; i < k; i++) L.app(b, v); eq(L.rd(b), Array(k).fill(v)); });
			P(`B3-${L.l}`, "corrupt/wrong-shape lines are skipped; valid lines keep order", fc.array(fc.oneof(L.arb.map((v) => ({ v })), A.garbage.map((g) => ({ g }))), { maxLength: 10 }), (b, items) => {
				for (const it2 of items) "v" in it2 ? L.app(b, it2.v) : b.hooks.injectCorruptLine(L.l, it2.g);
				eq(L.rd(b), items.flatMap((x) => ("v" in x ? [x.v] : [])));
			});
			P(`B4-${L.l}`, "a torn (unterminated) tail does not swallow the next valid append", fc.tuple(L.arb, A.garbage), (b, [v, g]) => {
				if (!b.hooks.injectTornTail) return;
				b.hooks.injectTornTail(L.l, g);
				L.app(b, v);
				eq(L.rd(b), [v]);
			});
			P(`B5-${L.l}`, "a fresh store reads as empty, and returned arrays are copies (mutation does not leak)", lines, (b, ls) => {
				eq(L.rd(b), []);
				ls.forEach((v) => L.app(b, v));
				const r = L.rd(b); r.length = 0;
				eq(L.rd(b), ls);
			});
		}
	});

	describe(`${f.name}: C rewriteLedgers = exactly the kept lines`, () => {
		type Op =
			| { t: "n"; v: GraphNode } | { t: "c"; v: GraphChain } | { t: "cov"; v: CoverageEntry } | { t: "cp"; v: SessionCheckpoint }
			| { t: "bad"; l: Ledger; g: string }
			| { t: "rw"; keys: Ledger[]; fresh: boolean; mask: boolean[]; nn: GraphNode[]; cc: GraphChain[]; vv: CoverageEntry[]; pp: SessionCheckpoint[] };
		const ledgerArb = fc.constantFrom<Ledger>("nodes", "chains", "coverage", "checkpoints");
		const op: fc.Arbitrary<Op> = fc.oneof(
			A.nodeLine.map((v) => ({ t: "n", v }) as Op), A.chainLine.map((v) => ({ t: "c", v }) as Op),
			A.coverageLine.map((v) => ({ t: "cov", v }) as Op), A.checkpointLine.map((v) => ({ t: "cp", v }) as Op),
			fc.record({ t: fc.constant("bad" as const), l: ledgerArb, g: A.garbage }),
			fc.record({ t: fc.constant("rw" as const), keys: fc.uniqueArray(ledgerArb, { maxLength: 4 }), fresh: fc.boolean(), mask: fc.array(fc.boolean(), { maxLength: 30 }), nn: fc.array(A.nodeLine, { maxLength: 3 }), cc: fc.array(A.chainLine, { maxLength: 3 }), vv: fc.array(A.coverageLine, { maxLength: 3 }), pp: fc.array(A.checkpointLine, { maxLength: 3 }) }),
		);
		const apply = (b: StoreBundle, m: Record<Ledger, any[]>, o: Op) => {
			if (o.t === "n") { b.graph.appendNode(o.v); m.nodes.push(o.v); }
			else if (o.t === "c") { b.graph.appendChain(o.v); m.chains.push(o.v); }
			else if (o.t === "cov") { b.graph.appendCoverage(o.v); m.coverage.push(o.v); }
			else if (o.t === "cp") { b.graph.appendCheckpoint(o.v); m.checkpoints.push(o.v); }
			else if (o.t === "bad") b.hooks.injectCorruptLine(o.l, o.g);
			else {
				const pick = (l: Ledger, fr: any[]) => (o.fresh ? fr : m[l].filter((_, i) => o.mask[i % Math.max(o.mask.length, 1)] ?? true));
				const next: any = {};
				for (const k of o.keys) next[k] = pick(k, { nodes: o.nn, chains: o.cc, coverage: o.vv, checkpoints: o.pp }[k]);
				b.graph.rewriteLedgers(next);
				for (const k of o.keys) m[k] = next[k];
			}
		};
		const reads = (b: StoreBundle) => ({ nodes: b.graph.readNodes(), chains: b.graph.readChains(), coverage: b.graph.readCoverage(), checkpoints: b.graph.readCheckpoints() });
		P("C1", "MODEL: random append/corrupt/rewrite sequences always read back equal to the in-memory model (kept lines exactly; absent keys untouched; appends continue after kept)", fc.array(op, { maxLength: 25 }), (b, ops) => {
			const m: Record<Ledger, any[]> = { nodes: [], chains: [], coverage: [], checkpoints: [] };
			for (const o of ops) { apply(b, m, o); eq(reads(b), m); }
		});
		P("C2", "rewriteLedgers({}) is a no-op; rewriting one ledger leaves the other three AND sources/positions untouched", fc.tuple(fc.array(A.nodeLine, { maxLength: 4 }), fc.array(A.coverageLine, { maxLength: 4 })), (b, [ns, cv]) => {
			putAll(b, ns); cv.forEach((c) => b.graph.appendCoverage(c));
			b.graph.writePositions({ n1: { x: 1, y: 2 } });
			b.graph.upsertSource({ id: "src_1", filePath: "/x", importedAt: "t" });
			const s0 = state(b.graph);
			b.graph.rewriteLedgers({}); eq(state(b.graph), s0);
			b.graph.rewriteLedgers({ nodes: [] });
			eq(b.graph.readCoverage(), cv); eq(b.graph.readNodes(), []);
			eq(b.graph.readPositions(), { n1: { x: 1, y: 2 } }); eq(b.graph.readSources().length, 1);
		});
		P("C3", "rewriteLedgers is idempotent", fc.array(A.chainLine, { maxLength: 6 }), (b, cs) => {
			b.graph.rewriteLedgers({ chains: cs }); const s = state(b.graph);
			b.graph.rewriteLedgers({ chains: cs }); eq(state(b.graph), s); eq(b.graph.readChains(), cs);
		});
	});

	describe(`${f.name}: D transact atomicity`, () => {
		/** Throws at the failAt-th mutator call; `hit.fired` says whether it did. */
		const fault = (g: GraphStore, failAt: number, hit: { fired: boolean }): GraphStore => {
			let n = 0;
			const MUT = new Set(["appendNode", "appendChain", "appendCheckpoint", "appendCoverage", "rewriteLedgers"]);
			return new Proxy(g, { get: (t: any, p: string) => { const v = t[p]; if (typeof v !== "function") return v; return MUT.has(p) ? (...a: any[]) => { if (++n === failAt) { hit.fired = true; throw new Error("injected"); } return v.apply(t, a); } : v.bind(t); } });
		};
		P("D1", "a mergeFindings that throws mid-way (no transact wrapper in the test) leaves NO change", fc.tuple(stepArb(), stepArb(), fc.integer({ min: 1, max: 12 })), (b, [s1, s2, k]) => {
			runStep({ chatStore: b.chats, graphStore: b.graph }, s1);
			const before = state(b.graph);
			const hit = { fired: false };
			let threw = false;
			try { runStep({ chatStore: b.chats, graphStore: fault(b.graph, k, hit) }, s2); } catch { threw = true; }
			if (hit.fired) { assert.ok(threw, "an injected fault was swallowed"); eq(state(b.graph), before); }
		});
		type TOp = { t: "n"; v: GraphNode } | { t: "c"; v: GraphChain } | { t: "cov"; v: CoverageEntry } | { t: "rw" };
		const tops = fc.array(fc.oneof(A.nodeLine.map((v) => ({ t: "n", v }) as TOp), A.chainLine.map((v) => ({ t: "c", v }) as TOp), A.coverageLine.map((v) => ({ t: "cov", v }) as TOp), fc.constant({ t: "rw" } as TOp)), { maxLength: 8 });
		P("D2", "MODEL: transact(fn) runs fn, commits all ops in call order and returns fn's value; a throw at ANY point rethrows and leaves state identical to before", fc.array(fc.record({ ops: tops, throwAt: fc.option(fc.nat(8), { nil: undefined }) }), { maxLength: 6 }), (b, txs) => {
			const m: any = { nodes: [], chains: [], coverage: [] };
			for (const tx of txs) {
				const before = state(b.graph);
				const staged = structuredClone(m);
				let ran = false;
				let r: number | undefined;
				let thrown: unknown;
				try {
					r = b.graph.transact("t", () => {
						ran = true;
						tx.ops.forEach((o, i) => {
							if (tx.throwAt === i) throw new Error("boom");
							if (o.t === "n") { b.graph.appendNode(o.v); staged.nodes.push(o.v); }
							if (o.t === "c") { b.graph.appendChain(o.v); staged.chains.push(o.v); }
							if (o.t === "cov") { b.graph.appendCoverage(o.v); staged.coverage.push(o.v); }
							if (o.t === "rw") { staged.chains = staged.chains.slice(1); b.graph.rewriteLedgers({ chains: [...staged.chains] }); }
						});
						if (tx.throwAt !== undefined && tx.throwAt >= tx.ops.length) throw new Error("boom");
						return 42;
					});
				} catch (e) { thrown = e; }
				assert.ok(ran, "transact never ran fn");
				if (tx.throwAt !== undefined) {
					assert.ok(thrown instanceof Error && thrown.message === "boom", "transact must rethrow fn's error");
					eq(state(b.graph), before);
				} else {
					assert.equal(thrown, undefined, "transact threw although fn returned");
					eq(r, 42);
					Object.assign(m, staged);
					eq([b.graph.readNodes(), b.graph.readChains(), b.graph.readCoverage()], [m.nodes, m.chains, m.coverage]);
				}
			}
		});
		// ids are minted randomly: name each n_/arg_ id by its order of first appearance so two runs compare.
		const canon = (g: GraphStore) => { const seen = new Map<string, string>(); return state(g).replace(/\b(?:n|arg)_\w+/g, (m) => { if (!seen.has(m)) seen.set(m, `#${seen.size}`); return seen.get(m)!; }); };
		P("D3", "mergeFindings run inside transact is atomic under a fault at every write position (incl. the simplify rewrite and coverage appends), and commits when no fault fires (same state as a plain run, modulo minted ids)", fc.tuple(stepArb(), stepArb(), fc.integer({ min: 1, max: 14 })), async (b, [s1, s2, k]) => {
			mock.timers.enable({ apis: ["Date"], now: 0 }); // one fixed clock for both runs, so createdAt is equal on both sides
			let p: StoreBundle | undefined;
			try {
				runStep({ chatStore: b.chats, graphStore: b.graph }, s1);
				const before = state(b.graph);
				const hit = { fired: false };
				let threw = false;
				try { b.graph.transact("merge", () => runStep({ chatStore: b.chats, graphStore: fault(b.graph, k, hit) }, s2)); } catch { threw = true; }
				if (hit.fired) { assert.ok(threw, "an injected fault was swallowed by transact"); eq(state(b.graph), before); return; }
				assert.ok(!threw, "transact threw without a fault");
				p = await fresh();
				runStep({ chatStore: p.chats, graphStore: p.graph }, s1);
				runStep({ chatStore: p.chats, graphStore: p.graph }, s2);
				eq(canon(b.graph), canon(p.graph));
			} finally { mock.timers.reset(); p?.dispose(); }
		});
		// D4: expected commits come from the operation spec, never from the store.
		type D4Op =
			| { k: "tx"; label: string; n: number }
			| { k: "noop"; label: string }
			| { k: "nested"; outer: string; inner: string }
			| { k: "throw"; label: string }
			| { k: "bare"; m: "appendNode" | "upsertSource" };
		const d4Label = fc.stringMatching(/^[a-z][a-z0-9 :_-]{0,15}$/);
		const d4Op: fc.Arbitrary<D4Op> = fc.oneof(
			fc.record({ k: fc.constant("tx" as const), label: d4Label, n: fc.integer({ min: 1, max: 3 }) }),
			fc.record({ k: fc.constant("noop" as const), label: d4Label }),
			fc.record({ k: fc.constant("nested" as const), outer: d4Label, inner: d4Label }),
			fc.record({ k: fc.constant("throw" as const), label: d4Label }),
			fc.record({ k: fc.constant("bare" as const), m: fc.constantFrom("appendNode" as const, "upsertSource" as const) }),
		);
		P("D4", "one durable commit per transact: the label is the message, nested counts once under the OUTER label, a no-op or a throw adds none, a bare write is auto:<method>", fc.array(d4Op, { minLength: 1, maxLength: 12 }), (b, ops) => {
			const messages = b.hooks.commitMessages!.bind(b.hooks); // present whenever capabilities.commits (checked against the bundle above)
			let id = 0;
			const node = () => ({ id: `d4n${id++}`, name: "n", statement: "s", aliases: [], createdAt: "t", provenance: [] }) as GraphNode;
			b.graph.appendNode(node()); // the store exists from here (the first write also creates and migrates it)
			for (const op of ops) {
				const before = messages();
				let expected: string[];
				if (op.k === "tx") { b.graph.transact(op.label, () => { for (let i = 0; i < op.n; i++) b.graph.appendNode(node()); }); expected = [op.label]; }
				else if (op.k === "noop") { b.graph.transact(op.label, () => { b.graph.readNodes(); }); expected = []; }
				else if (op.k === "nested") { b.graph.transact(op.outer, () => { b.graph.appendNode(node()); b.graph.transact(op.inner, () => { b.graph.appendNode(node()); }); }); expected = [op.outer]; }
				else if (op.k === "throw") { assert.throws(() => b.graph.transact(op.label, () => { b.graph.appendNode(node()); throw new Error("boom"); }), /boom/); expected = []; }
				else if (op.m === "appendNode") { b.graph.appendNode(node()); expected = ["auto:appendNode"]; }
				else { b.graph.upsertSource({ id: `d4s${id++}`, filePath: "/x", importedAt: "t" }); expected = ["auto:upsertSource"]; }
				const after = messages();
				eq(after.slice(0, expected.length), expected);
				eq(after.slice(expected.length), before);
			}
		}, f.capabilities.commits ? {} : { skip: "not a versioned back-end" });
	});

	describe(`${f.name}: E coverage ledger`, () => {
		const cov = fc.array(A.coverageLine, { maxLength: 10 });
		P("E1", "appendCoverage/readCoverage: duplicates preserved in order (multiset), empty store reads []", cov, (b, es) => { eq(b.graph.readCoverage(), []); es.forEach((e) => b.graph.appendCoverage(e)); eq(b.graph.readCoverage(), es); });
		P("E2", "covered set is idempotent under re-append and order-insensitive", fc.tuple(cov, fc.nat(3)), (b, [es, extra]) => {
			es.forEach((e) => b.graph.appendCoverage(e));
			const once = coveredSet(b.graph.readCoverage(), "c1");
			for (let i = 0; i < extra; i++) [...es].reverse().forEach((e) => b.graph.appendCoverage(e));
			eq(coveredSet(b.graph.readCoverage(), "c1"), once);
			eq([...once].sort(), [...new Set(es.filter((e) => e.chatId === "c1").map((e) => e.fp))].sort());
		});
		P("E3", "mergeFindings: covered set after a successful merge ⊇ batch fps; replaying the same batch leaves the covered set unchanged", fc.tuple(stepArb(), cov), (b, [s, es]) => {
			const step = { ...s, cov: es.map((e) => ({ ...e, chatId: s.chatId })) };
			runStep({ chatStore: b.chats, graphStore: b.graph }, step);
			const c1 = coveredSet(b.graph.readCoverage(), s.chatId);
			for (const e of step.cov) assert.ok(c1.has(e.fp));
			runStep({ chatStore: b.chats, graphStore: b.graph }, step);
			eq(coveredSet(b.graph.readCoverage(), s.chatId), c1);
		});
		P("E5", "a torn (unterminated) coverage tail does not swallow the next valid coverage append", fc.tuple(A.coverageLine, A.garbage), (b, [v, g]) => {
			if (!b.hooks.injectTornTail) return;
			b.hooks.injectTornTail("coverage", g); b.graph.appendCoverage(v); eq(b.graph.readCoverage(), [v]);
		});
		P("E4", "coverage is never ahead of the data: a merge that fails before the coverage step appends NO coverage", fc.tuple(stepArb(), cov, fc.integer({ min: 1, max: 10 })), (b, [s, es, k]) => {
			const step = { ...s, cov: es.map((e) => ({ ...e, chatId: s.chatId })) };
			const g = (() => { let n = 0; return new Proxy(b.graph, { get: (t: any, p: string) => { const v = t[p]; if (typeof v !== "function") return v; return ["appendNode", "appendChain", "rewriteLedgers"].includes(p) ? (...a: any[]) => { if (++n === k) throw new Error("injected"); return v.apply(t, a); } : v.bind(t); } }); })();
			try { runStep({ chatStore: b.chats, graphStore: g }, step); } catch { eq(b.graph.readCoverage(), []); }
		});
	});

	describe(`${f.name}: F mergeFindings / simplifyChains invariants`, () => {
		const lines = fc.array(A.saneChainLine, { maxLength: 8 });
		/** Acyclic: premises have a lower index than the conclusion (what the extractor is meant to emit). */
		const ix = (n: string) => Number(n.slice(1));
		const dag = fc.array(A.chainLine.map((c) => { const premises = c.premises.filter((p) => ix(p) < ix(c.conclusion)); return premises.length ? { ...c, premises } : null; }).filter((c): c is GraphChain => c !== null), { maxLength: 8 });
		const sameLine = (a: GraphChain[], b: GraphChain[]) => { let i = 0; return a.every((x) => { while (i < b.length && b[i] !== x) i++; return i++ < b.length; }); };
		P("F1", "simplifyChains result is an order-preserving subset of its input lines", lines, (_b, ls) => assert.ok(sameLine(simplifyChains(ls), ls)));
		P("F2", "simplifyChains keeps or drops a logical chain (key) as a whole", lines, (_b, ls) => {
			const kept = simplifyChains(ls);
			const keptKeys = new Set(kept.map((l) => key(l.premises, l.conclusion)));
			for (const l of ls) eq(keptKeys.has(key(l.premises, l.conclusion)), kept.includes(l));
		});
		P("F3", "simplifyChains is idempotent (acyclic input)", dag, (_b, ls) => { const once = simplifyChains(ls); eq(simplifyChains(once), once); });
		P("F4", "simplifyChains never removes a conclusion: every concluded node keeps >=1 chain", lines, (_b, ls) => eq(new Set(simplifyChains(ls).map((l) => l.conclusion)), new Set(ls.map((l) => l.conclusion))));
		P("F5", "every dropped chain's conclusion is still derivable from its premises via kept chains (closure(premises, kept) ∋ conclusion; acyclic input)", dag, (_b, ls) => {
			const kept = simplifyChains(ls);
			for (const d of ls.filter((l) => !kept.includes(l))) assert.ok(closure(d.premises, kept).has(d.conclusion), `dropped ${JSON.stringify(d)} no longer derivable`);
		});
		P("F6", "global derivability is preserved: closure(leaf nodes, kept) == closure(leaf nodes, all) (acyclic input)", dag, (_b, ls) => {
			const leaves = [...new Set(ls.flatMap((l) => l.premises))].filter((n) => !ls.some((l) => l.conclusion === n));
			eq([...closure(leaves, simplifyChains(ls))].sort(), [...closure(leaves, ls)].sort());
		});
		P("F3c", "simplifyChains is idempotent on CYCLIC input too (extractor refuses cycles, but nothing at the store seam does)", lines, (_b, ls) => { const once = simplifyChains(ls); eq(simplifyChains(once), once); });
		// One createdAt for every line: the id-dependent tie-break is only reached on equal count AND equal createdAt (at 3 stamps, 100 runs missed it).
		const tied = fc.array(A.saneChainLine.map((c) => ({ ...c, createdAt: "2026-01-01T00:00:00.000Z" })), { minLength: 4, maxLength: 10 });
		P("F11", "simplifyChains commutes with renaming node ids (ids are minted randomly; the kept set must not depend on them)", fc.tuple(tied, fc.infiniteStream(fc.nat())), (_b, [ls, rnd]) => {
			const ids = [...new Set(ls.flatMap((l) => [...l.premises, l.conclusion]))];
			const it = rnd[Symbol.iterator]();
			const perm = [...ids]; // Fisher-Yates over the same pool: reorders the key strings
			for (let i = perm.length - 1; i > 0; i--) { const j = it.next().value % (i + 1); [perm[i], perm[j]] = [perm[j]!, perm[i]!]; }
			const m = new Map(ids.map((id, i) => [id, perm[i]!]));
			const rename = (xs: GraphChain[]) => xs.map((l) => ({ ...l, premises: l.premises.map((p) => m.get(p) ?? p), conclusion: m.get(l.conclusion) ?? l.conclusion }));
			eq(simplifyChains(rename(ls)), rename(simplifyChains(ls)));
		});
		const steps = fc.array(stepArb(), { minLength: 1, maxLength: 4 });
		P("F7", "after every mergeFindings: no dangling chain endpoint, premises non-empty/unique/!= conclusion", steps, (b, ss) => {
			const deps = { chatStore: b.chats, graphStore: b.graph };
			for (const s of ss) {
				runStep(deps, s);
				const g = getGraph(b.graph); const ids = new Set(g.nodes.map((n) => n.id));
				for (const c of g.chains) {
					assert.ok(c.premises.length > 0 && new Set(c.premises).size === c.premises.length && !c.premises.includes(c.conclusion));
					assert.ok(ids.has(c.conclusion) && c.premises.every((p) => ids.has(p)), `dangling chain ${JSON.stringify(c)}`);
				}
			}
		});
		P("F8", "mergeFindings is append-only on nodes (old lines are a prefix) and chains only shrink via simplify; stats account for line deltas", steps, (b, ss) => {
			const deps = { chatStore: b.chats, graphStore: b.graph };
			for (const s of ss) {
				const n0 = b.graph.readNodes(), c0 = b.graph.readChains();
				const st = runStep(deps, s);
				const n1 = b.graph.readNodes(), c1 = b.graph.readChains();
				eq(n1.slice(0, n0.length), n0);
				assert.ok(n1.length >= n0.length);
				eq(st.nodes, new Set(n1.map((n) => n.id)).size - new Set(n0.map((n) => n.id)).size);
				eq(c1.length, c0.length + (st.chains ?? 0) - (st.droppedChains ?? 0));
			}
		});
		P("F9", "the chain ledger is already simplified after a merge (simplifyChains(readChains()) is a no-op)", steps, (b, ss) => {
			for (const s of ss) { runStep({ chatStore: b.chats, graphStore: b.graph }, s); const c = b.graph.readChains(); eq(simplifyChains(c), c); }
		});
		P("F10", "a chat asserts a given (premises, conclusion) on at most ONE chain line (merge dedupes per chat)", steps, (b, ss) => {
			const deps = { chatStore: b.chats, graphStore: b.graph };
			for (const s of ss) runStep(deps, s);
			const seen = new Map<string, number>();
			for (const c of b.graph.readChains()) for (const chat of new Set(c.provenance.map((p) => p.chatId))) { const k = `${chat}|${key(c.premises, c.conclusion)}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
			for (const [k, n] of seen) assert.ok(n <= 1, `${k} asserted on ${n} lines`);
		});
	});

	describe(`${f.name}: R review ledger (R2)`, () => {
		const rvs = fc.array(A.reviewLine, { maxLength: 8 });
		// Valid JSON, wrong shape: each breaks exactly one rule of the line contract. Hand-written, so the expectation never comes from the guard.
		const base = { id: "c1:k1", chatId: "c1", problemCallId: "k1", at: "2026-01-01T00:00:00.000Z", targets: ["n1"], outcome: "solved", rung: null };
		const invalid = [
			{ ...base, targets: [] }, { ...base, targets: "n1" }, { ...base, targets: [1] }, { ...base, outcome: "won" }, { ...base, rung: "R9" }, { ...base, rung: undefined },
			{ ...base, mode: "speed" }, { ...base, missClass: "oops" }, { ...base, confidence: 101 }, { ...base, confidence: -1 }, { ...base, confidence: "90" }, { ...base, id: 7 },
			{ ...base, chatId: undefined }, { ...base, at: 5 },
		];
		P("R1", "an invalid-shape review line (empty targets, unknown outcome/rung/mode/missClass, confidence out of 0-100, missing or mistyped field) is skipped, never guessed at; valid lines keep order", fc.array(fc.oneof(A.reviewLine.map((v) => ({ v })), fc.constantFrom(...invalid).map((bad) => ({ bad }))), { maxLength: 10 }), (b, items) => {
			for (const it2 of items) "v" in it2 ? b.graph.appendReview(it2.v) : b.hooks.injectCorruptLine("reviews", JSON.stringify(it2.bad));
			eq(b.graph.readReviews(), items.flatMap((x) => ("v" in x ? [x.v] : [])));
		});
		P("R2", "reviews are NOT part of rewriteLedgers: rewriting any/all other ledgers leaves every review line, in order", fc.tuple(rvs, fc.array(A.nodeLine, { maxLength: 3 })), (b, [rs, ns]) => {
			rs.forEach((r) => b.graph.appendReview(r)); putAll(b, ns);
			b.graph.rewriteLedgers({ nodes: [], chains: [], coverage: [], checkpoints: [] });
			eq(b.graph.readReviews(), rs); eq(b.graph.readNodes(), []);
		});
		P("R3", "inside transact: appends are read-your-writes in call order and, on commit, persist in that order after earlier lines", fc.tuple(rvs, rvs), (b, [before, inside]) => {
			before.forEach((r) => b.graph.appendReview(r));
			b.graph.transact("rv", () => {
				inside.forEach((r, i) => { b.graph.appendReview(r); eq(b.graph.readReviews(), [...before, ...inside.slice(0, i + 1)]); });
			});
			eq(b.graph.readReviews(), [...before, ...inside]);
		});
		P("R4", "a transact that throws after appendReview (or whose nested transact threw and was caught) leaves no review behind", fc.tuple(rvs, rvs, fc.boolean()), (b, [before, inside, nested]) => {
			before.forEach((r) => b.graph.appendReview(r));
			assert.throws(() => b.graph.transact("rv", () => {
				inside.forEach((r) => b.graph.appendReview(r));
				if (nested) { try { b.graph.transact("in", () => { throw new Error("inner"); }); } catch { /* caught on purpose: still poisons the outer */ } return; }
				throw new Error("boom");
			}), /./);
			eq(b.graph.readReviews(), before);
		});
		P("R5", "a review append moves the revision; a rolled-back one does not (SQL: reviews bump lh_meta.revision like the other ledgers)", rvs.filter((x) => x.length > 0), (b, rs) => {
			const rev = (b.graph as unknown as { revision?: () => number }).revision;
			if (!f.capabilities.revision || !rev) return;
			const r0 = rev.call(b.graph);
			assert.throws(() => b.graph.transact("rv", () => { b.graph.appendReview(rs[0]!); throw new Error("boom"); }), /boom/);
			eq(rev.call(b.graph), r0);
			b.graph.appendReview(rs[0]!);
			assert.ok(rev.call(b.graph) > r0, "revision did not move");
		});
		P("R6", "corruptLines() counts invalid review lines and valid ones are not counted", fc.tuple(rvs, fc.array(fc.constantFrom(...invalid), { maxLength: 4 })), (b, [rs, bad]) => {
			const cl = (b.graph as unknown as { corruptLines?: () => number }).corruptLines;
			if (!cl) return;
			rs.forEach((r) => b.graph.appendReview(r)); bad.forEach((x) => b.hooks.injectCorruptLine("reviews", JSON.stringify(x)));
			eq(cl.call(b.graph), bad.length);
		}, f.capabilities.corruptLines ? {} : { todo: "lh-bhc" });
	});

	describe(`${f.name}: M review remaps (a merged node's reviews follow it)`, () => {
		const ids = ["n1", "n2", "n3", "n4", "n5"];
		// Acyclic by construction (always towards a higher index), so every sequence is accepted and the oracle is a plain fixed-point loop.
		const upward = fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 1, max: 4 })).filter(([a, d]) => a + d <= 4).map(([a, d]) => ({ from: ids[a]!, to: ids[a + d]! })), { maxLength: 6 });
		const oracle = (rs: ReviewLine[], remaps: { from: string; to: string }[]): ReviewLine[] => {
			const last = new Map(remaps.map((r) => [r.from, r.to]));
			const fin = (t: string): string => { let c = t; while (last.has(c)) c = last.get(c)!; return c; };
			return rs.map((r) => ({ ...r, targets: r.targets.map(fin).filter((t, i, all) => all.indexOf(t) === i) }));
		};
		const rvs = fc.array(A.reviewLine, { maxLength: 6 });
		P("M1", "readReviews resolves every target through the remap chain (a->b, b->c reads c; the last remap of a `from` wins; targets dedupe), keeping line order and every other field", fc.tuple(rvs, upward), (b, [rs, remaps]) => {
			rs.forEach((r) => b.graph.appendReview(r));
			remaps.forEach((m) => b.graph.remapReviewTargets(m.from, m.to));
			eq(b.graph.readReviews(), oracle(rs, remaps));
		});
		P("M2", "remaps are append-only history: a review appended AFTER a remap of its target is resolved too, and a remap to an id no review mentions changes nothing", fc.tuple(rvs, rvs), (b, [before, after]) => {
			before.forEach((r) => b.graph.appendReview(r));
			b.graph.remapReviewTargets("n1", "n2"); b.graph.remapReviewTargets("n2", "n3");
			b.graph.remapReviewTargets("unreviewed", "n9"); // no line mentions it
			after.forEach((r) => b.graph.appendReview(r));
			const want = oracle([...before, ...after], [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }]);
			eq(b.graph.readReviews(), want);
		});
		P("M3", "a remap that would make a cycle (self, a->b->a, a->b->c->a) throws, writes nothing, and does not poison an enclosing transact", fc.tuple(rvs, fc.constantFrom("self", "two", "three")), (b, [rs, kind]) => {
			rs.forEach((r) => b.graph.appendReview(r));
			b.graph.remapReviewTargets("n3", "n4"); // an unrelated, valid remap stays
			const cycle = { self: [["n1", "n1"]], two: [["n1", "n2"], ["n2", "n1"]], three: [["n1", "n2"], ["n2", "n5"], ["n5", "n1"]] }[kind]!;
			b.graph.transact("c", () => {
				for (const [from, to] of cycle.slice(0, -1)) b.graph.remapReviewTargets(from!, to!);
				const [from, to] = cycle[cycle.length - 1]!;
				assert.throws(() => b.graph.remapReviewTargets(from!, to!), /cycle/);
				if (kind === "self") assert.throws(() => b.graph.remapReviewTargets("n1", "n1"), /cycle/);
			});
			// the acyclic prefix committed; the refused edge did not: reads must terminate and equal the oracle over the prefix only
			eq(b.graph.readReviews(), oracle(rs, [{ from: "n3", to: "n4" }, ...cycle.slice(0, -1).map(([from, to]) => ({ from: from!, to: to! }))]));
		});
		P("M4", "a cycle that is already on disk is refused on read with a clear error, not looped on", rvs, (b, rs) => {
			rs.forEach((r) => b.graph.appendReview(r));
			b.hooks.injectCorruptLine("reviewRemaps", JSON.stringify({ from: "n1", to: "n2" }));
			b.hooks.injectCorruptLine("reviewRemaps", JSON.stringify({ from: "n2", to: "n1" }));
			assert.throws(() => b.graph.readReviews(), /cycle/);
		});
		P("M5", "remap inside transact: read-your-writes, and a throw (or caught nested throw) after it leaves no remap; a commit keeps it", fc.tuple(rvs, fc.constantFrom("commit", "throw", "caught")), (b, [rs, how]) => {
			rs.forEach((r) => b.graph.appendReview(r));
			const plain = oracle(rs, []);
			const run = () => b.graph.transact("m", () => {
				b.graph.remapReviewTargets("n1", "n2");
				eq(b.graph.readReviews(), oracle(rs, [{ from: "n1", to: "n2" }]));
				if (how === "throw") throw new Error("boom");
				if (how === "caught") { try { b.graph.transact("in", () => { throw new Error("inner"); }); } catch { /* caught on purpose */ } }
			});
			if (how === "commit") { run(); eq(b.graph.readReviews(), oracle(rs, [{ from: "n1", to: "n2" }])); }
			else { assert.throws(run, /./); eq(b.graph.readReviews(), plain); }
		});
		P("M6", "invalid remap lines (missing/mistyped from or to) are skipped, never guessed at", rvs, (b, rs) => {
			rs.forEach((r) => b.graph.appendReview(r));
			for (const bad of [{ from: "n1" }, { to: "n2" }, { from: 1, to: "n2" }, { from: "n1", to: null }]) b.hooks.injectCorruptLine("reviewRemaps", JSON.stringify(bad));
			eq(b.graph.readReviews(), oracle(rs, []));
		});
	});

	describe(`${f.name}: G format-version guard`, () => {
		const reads = (b: StoreBundle): [string, () => unknown][] => [
			["readNodes", () => b.graph.readNodes()], ["readChains", () => b.graph.readChains()], ["readCheckpoints", () => b.graph.readCheckpoints()],
			["readCoverage", () => b.graph.readCoverage()], ["readReviews", () => b.graph.readReviews()], ["readSources", () => b.graph.readSources()], ["sourceOrg.read", () => b.sourceOrg.read()], ["render.read", () => b.render.read()],
		];
		P("G1", "a newer-stamped data folder makes EVERY graph-family read throw (never silently skip)", fc.array(A.nodeLine, { maxLength: 3 }), (b, ns) => {
			putAll(b, ns); b.hooks.stampNewerFormat();
			for (const [name, r] of reads(b)) assert.throws(r, /./, `${name} did not refuse a newer format`);
		});
		const writes = (b: StoreBundle): [string, () => unknown][] => [
			["appendNode", () => b.graph.appendNode({ id: "n1", name: "", statement: "", aliases: [], createdAt: "t", provenance: [] })],
			["appendChain", () => b.graph.appendChain({ id: "arg_1", premises: ["n1"], conclusion: "n2", createdAt: "t", provenance: [] })],
			["appendCoverage", () => b.graph.appendCoverage({ chatId: "c1", fp: "f", tokens: 1, foldedAt: "t" })],
			["appendCheckpoint", () => b.graph.appendCheckpoint({ chatId: "c1", foldedAt: "t" })],
			["remapReviewTargets", () => b.graph.remapReviewTargets("n1", "n2")],
			["appendReview", () => b.graph.appendReview({ id: "c1:k1", chatId: "c1", problemCallId: "k1", at: "t", targets: ["n1"], outcome: "solved", rung: null })],
			["rewriteLedgers", () => b.graph.rewriteLedgers({ nodes: [] })],
			["upsertSource", () => b.graph.upsertSource({ id: "src_1", filePath: "/x", importedAt: "t" })],
			["sourceOrg.write", () => b.sourceOrg.write({ version: 1, folders: [], placements: {} } as never)],
		];
		P("G2", "a newer-stamped data folder also REFUSES writes (a downgraded app must not append to / rewrite data it cannot interpret)", fc.constant(0), (b) => {
			b.hooks.stampNewerFormat();
			const accepted = writes(b).filter(([, w]) => { try { w(); return true; } catch { return false; } }).map(([n]) => n);
			eq(accepted, []); // lists every mutator that wrote into a newer-format folder
		});
		P("G3", "refusal is non-destructive: clearing the stamp restores the exact pre-stamp data", fc.array(A.nodeLine, { maxLength: 4 }), (b, ns) => {
			putAll(b, ns); const s0 = state(b.graph);
			b.hooks.stampNewerFormat(); for (const [, r] of reads(b)) try { r(); } catch { /* expected */ }
			b.hooks.clearFormatStamp(); eq(state(b.graph), s0);
		});
		T("G4", "an unstamped (legacy v1) or current-stamped folder is accepted: fresh reads do not throw", (b) => { for (const [, r] of reads(b)) r(); b.graph.appendNode({ id: "n1", name: "", statement: "", aliases: [], createdAt: "t", provenance: [] }); for (const [, r] of reads(b)) r(); });
	});

	describe(`${f.name}: H record round-trips`, () => {
		const title = fc.string({ maxLength: 12 });
		const json = fc.jsonValue().map((v) => JSON.parse(JSON.stringify(v)) as ReturnType<typeof JSON.parse>); // JSON-normalised (no -0)
		P("H1", "ChatStore.createChat/getChat: record round-trips; title trimmed, blank -> 'Untitled session'; practice kind marker", fc.tuple(title, fc.boolean()), (b, [t, practice]) => {
			const r = b.chats.createChat(t, practice ? "practice" : undefined);
			eq(b.chats.getChat(r.id), r);
			eq(r.title, t.trim() || "Untitled session");
			eq(r.kind, practice ? "practice" : undefined);
			eq(b.chats.getChat("chat_missing_000"), null);
		});
		P("H2", "ChatStore.saveMessages/saveTree/saveSettings/saveImageSnapshot-free fields round-trip and survive each other", fc.tuple(fc.array(fc.record({ id: fc.string({ minLength: 1, maxLength: 5 }), role: fc.constant("user"), content: fc.string({ maxLength: 8 }) }), { maxLength: 5 }), json, json), (b, [msgs, tree, settings]) => {
			const c = b.chats.createChat("t");
			b.chats.saveMessages(c.id, msgs as never); b.chats.saveTree(c.id, tree as never); b.chats.saveSettings(c.id, settings as never);
			const g = b.chats.getChat(c.id)!;
			eq(g.messages, msgs); eq(g.tree, tree); eq(g.settings, settings);
			b.chats.saveMessages(c.id, []); eq(b.chats.getChat(c.id)!.tree, tree);
			assert.throws(() => b.chats.saveMessages("chat_missing_000", []));
		});
		P("H3", "ChatStore.appendTurnUsage/appendExtractionUsage: idempotent per turn id / startedAt, otherwise append in order", fc.array(fc.nat(4), { maxLength: 10 }), (b, ids) => {
			const c = b.chats.createChat("t");
			for (const i of ids) { b.chats.appendTurnUsage(c.id, { id: `t${i}`, n: ids.length } as never); b.chats.appendExtractionUsage(c.id, { startedAt: i, at: "x" } as never); }
			const uniq = [...new Set(ids)];
			const g = b.chats.getChat(c.id)!;
			eq((g.turns ?? []).map((t: any) => t.id), uniq.map((i) => `t${i}`));
			eq((g.extractions ?? []).map((e: any) => e.startedAt), uniq);
		});
		P("H4", "ChatStore.renameChat/deleteChat: rename keeps updatedAt, blank->default; delete returns true once then false; getChat null", title, (b, t) => {
			const c = b.chats.createChat("a");
			const r = b.chats.renameChat(c.id, t); eq(r.title, t.trim() || "Untitled session"); eq(r.updatedAt, c.updatedAt);
			eq(b.chats.getChat(c.id)!.title, r.title);
			eq(b.chats.deleteChat(c.id), true); eq(b.chats.deleteChat(c.id), false); eq(b.chats.getChat(c.id), null);
			assert.ok(!b.chats.listChats().some((s) => s.id === c.id));
		});
		P("H5", "ChatStore.saveImageSnapshot: content-addressed, idempotent, wrong identity refused", fc.string({ maxLength: 10 }), (b, s) => {
			const c = b.chats.createChat("a");
			const data = Buffer.from(s).toString("base64");
			const id = require_sha256(Buffer.from(data, "base64"));
			const img = { mimeType: "image/png", data, width: 1, height: 1 };
			b.chats.saveImageSnapshot(c.id, id, img as never); b.chats.saveImageSnapshot(c.id, id, img as never);
			eq((b.chats.getChat(c.id) as any).imageSnapshots[id], img);
			assert.throws(() => b.chats.saveImageSnapshot(c.id, "0".repeat(64), img as never));
		});
		const jobInit = fc.record({ kind: fc.constantFrom("extraction", "probe") as fc.Arbitrary<any>, chatId: fc.constantFrom("c1", "c2"), toolCallId: fc.string({ minLength: 1, maxLength: 6 }), activity: fc.option(fc.string({ maxLength: 6 }), { nil: undefined }), input: fc.option(json, { nil: undefined }) });
		P("H6", "JobStore create/get/update: round-trip; update = old merged with patch; identity fields unchanged; unknown id -> null", fc.tuple(jobInit, fc.record({ activity: fc.string({ maxLength: 5 }), status: fc.constantFrom("running", "done", "error") as fc.Arbitrary<any>, result: json }, { requiredKeys: [] })), (b, [init, patch]) => {
			const j = b.jobs.createJob(init as never);
			eq(b.jobs.getJob(j.id), j); eq(j.status, "running"); eq(j.activity, init.activity ?? "starting");
			const u = b.jobs.updateJob(j.id, patch as never)!;
			eq({ ...u, updatedAt: 0 }, { ...j, ...patch, updatedAt: 0 }); eq(b.jobs.getJob(j.id), u);
			eq(b.jobs.updateJob("job_missing", {}), null); eq(b.jobs.getJob("job_missing"), null);
		});
		P("H7", "JobStore findJobByToolCallId / deleteJobsForChat: lookup scoped by chat; delete returns exactly that chat's count and spares others", fc.array(jobInit, { maxLength: 8 }), (b, inits) => {
			const made = inits.map((i) => b.jobs.createJob(i as never));
			for (const j of made) eq(b.jobs.findJobByToolCallId(j.chatId, j.toolCallId) !== null, true);
			eq(b.jobs.findJobByToolCallId("c1", "nope-nope"), null);
			const c1 = made.filter((j) => j.chatId === "c1").length;
			eq(b.jobs.deleteJobsForChat("c1"), c1); eq(b.jobs.listJobs("c1"), []);
			eq(b.jobs.listJobs("c2").length, made.length - c1);
			eq(b.jobs.deleteJobsForChat("c1"), 0);
		});
		P("H8", "SettingsStore: empty -> null; write then read is stable (read∘write is idempotent); non-object rejected", fc.dictionary(fc.string({ maxLength: 5 }), json, { maxKeys: 4 }), (b, rec) => {
			eq(b.settings.readSettings(), null);
			b.settings.writeSettings(rec as never); const r1 = b.settings.readSettings();
			b.settings.writeSettings(r1 as never); eq(b.settings.readSettings(), r1);
			assert.throws(() => b.settings.writeSettings(null as never));
		});
		P("H9", "RenderSettings: empty -> null; write returns sanitized value and read returns the same; re-write idempotent", json, (b, raw) => {
			eq(b.render.read(), null);
			const w = b.render.write(raw); eq(b.render.read(), w); eq(b.render.write(w), w);
		});
		const posKey = fc.constantFrom("n1", "n2", "constructor", "a b", "");
		P("H10", "positions: replace-whole round-trip (including ids like __proto__); second write fully replaces", fc.tuple(fc.array(fc.tuple(posKey, fc.double({ noNaN: true, noDefaultInfinity: true })), { maxLength: 5 }), fc.array(fc.tuple(posKey, fc.double({ noNaN: true, noDefaultInfinity: true })), { maxLength: 5 })), (b, [p1, p2]) => {
			const mk = (a: [string, number][]) => Object.fromEntries(a.map(([k, v]) => [k, { x: v + 0, y: 1 - v }]));
			eq(b.graph.readPositions(), {});
			b.graph.writePositions(mk(p1)); eq(b.graph.readPositions(), mk(p1));
			b.graph.writePositions(mk(p2)); eq(b.graph.readPositions(), mk(p2));
		});
		P("H10b", "hostile ids: positions/sources keyed by '__proto__' must round-trip (a SQL adapter will; the file adapter assigns into a plain object)", fc.constant(0), (b) => {
			b.graph.writePositions(Object.fromEntries([["__proto__", { x: 1, y: 2 }]]));
			eq(Object.keys(b.graph.readPositions()), ["__proto__"]);
			b.graph.appendSourceUsage("__proto__", { startedAt: 1 } as never); // no such source yet: a no-op, never a write into Object.prototype
			eq((({}) as { extractions?: unknown }).extractions, undefined);
			eq(b.graph.readSources(), []);
			b.graph.upsertSource({ id: "__proto__", filePath: "/x", importedAt: "t" });
			eq(b.graph.readSources().map((s) => s.id), ["__proto__"]);
		});
		type SOp = { t: "up"; id: string; path: string } | { t: "use"; id: string; at: number } | { t: "del"; ids: string[] };
		const sid = fc.constantFrom("src_1", "src_2", "src_3");
		P("H11", "MODEL: sources upsert/appendSourceUsage/deleteSources match a Map model (upsert keeps usage log; usage idempotent per startedAt; unknown id no-op; delete returns removed count)", fc.array(fc.oneof(fc.record({ t: fc.constant("up" as const), id: sid, path: fc.string({ maxLength: 4 }) }), fc.record({ t: fc.constant("use" as const), id: sid, at: fc.nat(3) }), fc.record({ t: fc.constant("del" as const), ids: fc.array(sid, { maxLength: 3 }) })) as fc.Arbitrary<SOp>, { maxLength: 15 }), (b, ops) => {
			const m = new Map<string, any>();
			for (const o of ops) {
				if (o.t === "up") { const prev = m.get(o.id); const rec: any = { id: o.id, filePath: o.path, importedAt: "t" }; if (prev?.extractions) rec.extractions = prev.extractions; m.set(o.id, rec); b.graph.upsertSource({ id: o.id, filePath: o.path, importedAt: "t" }); }
				else if (o.t === "use") { const r = m.get(o.id); if (r && !(r.extractions ?? []).some((x: any) => x.startedAt === o.at)) r.extractions = [...(r.extractions ?? []), { startedAt: o.at }]; b.graph.appendSourceUsage(o.id, { startedAt: o.at } as never); }
				else { const ids = new Set(o.ids); const removed = [...ids].filter((i) => m.delete(i)).length; eq(b.graph.deleteSources(ids), removed); }
				// readSources order is unspecified (DoltLite does not return insertion order): sort both sides before comparing
				const sort = (a: any[]) => [...a].sort((x, y) => x.id.localeCompare(y.id));
				eq(sort(b.graph.readSources()), sort([...m.values()]));
			}
		});
		P("H12", "SourceOrganizationStore: empty folders/placements round-trip; fresh store reads the empty state", fc.uniqueArray(fc.record({ id: fc.string({ minLength: 1, maxLength: 4 }), name: fc.string({ minLength: 1, maxLength: 4 }).filter((s) => s.trim() !== ""), parentId: fc.constant(null), createdAt: fc.constant("t") }), { selector: (f2) => f2.id, maxLength: 4 }), (b, folders) => {
			const empty = b.sourceOrg.read(); eq(empty.folders, []);
			const st = { ...empty, folders } as never;
			b.sourceOrg.write(st); eq(b.sourceOrg.read().folders, folders);
		});
		const seg = fc.constantFrom("system-prompt.md", "teacher/20-teaching.md");
		P("H13", "PromptOverrideStore: write/read/list(sorted)/delete; unknown -> null; delete absent is a no-op", fc.tuple(seg, fc.string({ maxLength: 20 })), (b, [p, text]) => {
			eq(b.prompts.listOverrides(), []); eq(b.prompts.readOverride(p), null);
			b.prompts.writeOverride(p, text); eq(b.prompts.readOverride(p), text); eq(b.prompts.listOverrides(), [p]);
			b.prompts.deleteOverride(p); eq(b.prompts.readOverride(p), null); b.prompts.deleteOverride(p);
		});
		const thread = fc.record({
			id: fc.string({ minLength: 1, maxLength: 5 }), open: fc.boolean(), createdAt: fc.constant("2026-01-01T00:00:00.000Z"),
			anchor: fc.record({ messageId: fc.string({ minLength: 1, maxLength: 4 }), partId: fc.string({ minLength: 1, maxLength: 4 }), blockIndex: fc.nat(3), blockText: fc.string({ maxLength: 6 }) }),
			messages: fc.array(fc.record({ id: fc.string({ minLength: 1, maxLength: 4 }), role: fc.constantFrom("user", "assistant") as fc.Arbitrary<"user" | "assistant">, text: fc.string({ maxLength: 6 }), at: fc.constant("2026-01-01T00:00:00.000Z") }), { maxLength: 3 }),
		});
		P("H15", "ChatStore.updateSideChats: read-your-writes, empty clears, silent (updatedAt/order kept), never clobbers messages, unknown chat -> null", fc.tuple(fc.array(thread, { maxLength: 4 }), fc.array(thread, { maxLength: 4 })), (b, [t1, t2]) => {
			const c = b.chats.createChat("t"); const other = b.chats.createChat("o");
			b.chats.saveMessages(c.id, [{ id: "m", role: "user", content: "keep" }] as never);
			const before = b.chats.getChat(c.id)!; const order = b.chats.listChats().map((s) => [s.id, s.updatedAt]);
			eq(b.chats.updateSideChats(c.id, (cur) => { eq(cur, []); return t1; }), t1);
			eq(b.chats.getChat(c.id)!.sideChats ?? [], t1);
			eq(b.chats.updateSideChats(c.id, (cur) => { eq(cur, t1); return t2; }), t2); // the callback sees what was stored
			eq(b.chats.getChat(c.id)!.sideChats ?? [], t2);
			eq({ ...b.chats.getChat(c.id)!, sideChats: undefined }, { ...before, sideChats: undefined }); // messages and updatedAt untouched
			eq(b.chats.listChats().map((s) => [s.id, s.updatedAt]), order);
			eq(b.chats.getChat(other.id)!.sideChats ?? [], []); // other chats untouched
			eq(b.chats.updateSideChats(c.id, () => []), []); eq(b.chats.getChat(c.id)!.sideChats ?? [], []);
			let called = false;
			eq(b.chats.updateSideChats("chat_missing_000", () => { called = true; return t1; }), null); eq(called, false);
			eq(b.chats.getChat("chat_missing_000"), null);
		});
		P("H16", "ChatStore.updateSideChats: a chat stamped with a NEWER schema version is refused (null, callback never called, file byte-identical)", fc.array(thread, { minLength: 1, maxLength: 3 }), (b, ts) => {
			const c = b.chats.createChat("t"); b.chats.updateSideChats(c.id, () => ts);
			b.hooks.stampNewerChat(c.id); const bytes = b.hooks.chatFileBytes(c.id)!;
			let called = false;
			eq(b.chats.updateSideChats(c.id, () => { called = true; return []; }), null);
			eq(called, false); eq(b.hooks.chatFileBytes(c.id)!.equals(bytes), true);
		});
		const authName = fc.stringMatching(/^[A-Z][A-Z0-9_]{1,8}$/);
		P("H14", "AuthStore: MODEL map semantics (set preserves others, delete absent = no-op, authVars on fresh = {})", fc.array(fc.tuple(fc.boolean(), authName, fc.string({ maxLength: 6 })), { maxLength: 10 }), (b, ops) => {
			const m: Record<string, string> = {}; eq(b.auth.authVars(), {});
			for (const [set, n, v] of ops) { if (set) { b.auth.setAuthVar(n, v); m[n] = v; } else { b.auth.deleteAuthVar(n); delete m[n]; } eq(b.auth.authVars(), m); }
		});
	});

	describe(`${f.name}: I ordering and identity`, () => {
		P("I1", "listChats is newest-activity-first, one summary per existing chat, no duplicates", fc.array(fc.nat(2), { minLength: 1, maxLength: 6 }), (b, touches) => {
			const ids = touches.map((_, i) => b.chats.createChat(`t${i}`).id);
			for (const t of touches) b.chats.saveMessages(ids[t % ids.length]!, []);
			const l = b.chats.listChats();
			eq(l.map((s) => s.id).sort(), [...ids].sort());
			for (let i = 1; i < l.length; i++) assert.ok(l[i - 1]!.updatedAt >= l[i]!.updatedAt);
		});
		P("I2", "silence law: rename/saveSettings/saveTree do not change any updatedAt or the list order", fc.array(fc.nat(2), { minLength: 2, maxLength: 5 }), (b, ts) => {
			const ids = ts.map((_, i) => b.chats.createChat(`t${i}`).id); ids.forEach((id) => b.chats.saveMessages(id, []));
			const before = b.chats.listChats().map((s) => [s.id, s.updatedAt]);
			ts.forEach((t, i) => { const id = ids[t % ids.length]!; b.chats.renameChat(id, `r${i}`); b.chats.saveSettings(id, { i } as never); b.chats.saveTree(id, { i } as never); });
			eq(b.chats.listChats().map((s) => [s.id, s.updatedAt]), before);
		});
		P("I3", "ids are unique across many createChat/createJob calls (identity never reused)", fc.integer({ min: 2, max: 25 }), (b, n) => {
			const ids = Array.from({ length: n }, () => b.chats.createChat("x").id); eq(new Set(ids).size, n);
			const js = Array.from({ length: n }, (_, i) => b.jobs.createJob({ kind: "extraction" as never, chatId: "c1", toolCallId: `t${i}` }).id); eq(new Set(js).size, n);
		});
		P("I4", "listJobs: scoped to the chat, newest updatedAt first", fc.array(fc.tuple(fc.constantFrom("c1", "c2"), fc.nat(50)), { maxLength: 8 }), (b, js) => {
			const made = js.map(([c, u], i) => ({ j: b.jobs.createJob({ kind: "extraction" as never, chatId: c, toolCallId: `t${i}` }), u }));
			const u = new Map<string, string>();
			made.forEach(({ j, u: n }, i) => { const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, n * 10 + i)).toISOString(); u.set(j.id, ts); b.jobs.updateJob(j.id, { updatedAt: ts }); });
			for (const c of ["c1", "c2"]) {
				const l = b.jobs.listJobs(c);
				eq(l.map((j) => j.id).sort(), made.filter((m) => m.j.chatId === c).map((m) => m.j.id).sort());
				for (let i = 1; i < l.length; i++) assert.ok(l[i - 1]!.updatedAt >= l[i]!.updatedAt);
			}
		});
		P("I5", "getGraph: nodes in first-encounter order, chains in first-key order; earlier entries keep identity and relative order when more lines are appended", fc.tuple(fc.array(A.nodeLine, { maxLength: 8 }), fc.array(A.nodeLine, { maxLength: 8 }), fc.array(A.chainLine, { maxLength: 6 }), fc.array(A.chainLine, { maxLength: 6 })), (b, [n1, n2, c1, c2]) => {
			putAll(b, n1, c1);
			const g1 = getGraph(b.graph);
			eq(g1.nodes.map((n) => n.id), [...new Set(n1.map((n) => n.id))]);
			eq(g1.chains.map((c) => key(c.premises, c.conclusion)), [...new Set(c1.map((c) => key(c.premises, c.conclusion)))]);
			putAll(b, n2, c2);
			const g2 = getGraph(b.graph);
			eq(g2.nodes.map((n) => n.id).slice(0, g1.nodes.length), g1.nodes.map((n) => n.id));
			eq(g2.chains.map((c) => c.id).slice(0, g1.chains.length), g1.chains.map((c) => c.id));
		});
		P("I6", "chain identity is stable: the merged chain's id is the FIRST line's id, whatever later assertions carry", fc.array(A.chainLine, { minLength: 1, maxLength: 8 }), (b, ls) => {
			putAll(b, [], ls);
			for (const c of getGraph(b.graph).chains) eq(c.id, ls.find((l) => key(l.premises, l.conclusion) === key(c.premises, c.conclusion))!.id);
		});
	});

	// ── Behaviour contract items 1, 2, 5, 6, 9-17 (architecture §2.1). A test is `todo` only while its API is absent,
	//    and the `todo` names the bead that lands it; `capabilities` is checked against the bundle so the allowance cannot go stale. ──
	describe(`${f.name}: N behaviour contract (storage-architecture §2.1)`, () => {
		const nodeAt = (i: number): GraphNode => ({ id: `n${(i % 5) + 1}`, name: "", statement: `s${i}`, aliases: [], createdAt: "t", provenance: [] });
		const need = <T>(v: T | undefined, what: string): T => { if (v === undefined) throw new Error(`pending: ${what} not implemented`); return v; };
		const revisionOf = (b: StoreBundle) => (b.graph as unknown as { revision?: () => unknown }).revision?.bind(b.graph);
		const corruptOf = (b: StoreBundle) => (b.graph as unknown as { corruptLines?: () => unknown }).corruptLines?.bind(b.graph);
		const exportAll = (b: StoreBundle) => JSON.stringify([b.graph.readNodes(), b.graph.readChains(), b.graph.readCoverage(), b.graph.readCheckpoints()]);
		const everything = (b: StoreBundle) => JSON.stringify([state(b.graph), b.graph.readSources(), b.graph.readPositions(), b.sourceOrg.read()]);
		const org = { version: 1, folders: [{ id: "f1", name: "A", parentId: null, createdAt: "t" }], placements: {} } as never;
		const src = (id: string) => ({ id, filePath: `/x/${id}`, importedAt: "t" });
		const usage = (startedAt: number) => ({ startedAt, at: "t", durationMs: 1, stages: { extractor: {}, auditor: {} } }) as never;
		const count = fc.integer({ min: 1, max: 8 });
		const events = (b: StoreBundle) => { const seen: string[] = []; const off = b.events.subscribe((e) => seen.push(e.type)); return { seen, off }; };

		it("capabilities match the opened bundle (a wrong flag would silently skip properties)", async () => {
			const b = await fresh();
			try {
				assert.equal(typeof b.graph.transact, "function", "GraphStore.transact is part of the port");
				assert.equal(revisionOf(b) !== undefined, f.capabilities.revision, "capabilities.revision");
				assert.equal(corruptOf(b) !== undefined, f.capabilities.corruptLines, "capabilities.corruptLines");
				assert.equal(b.hooks.commitMessages !== undefined, f.capabilities.commits, "capabilities.commits");
			} finally { b.dispose(); }
			const d = await fresh();
			try {
				d.hooks.stampNewerFormat();
				let refused = false;
				try { await reopen(f, d); } catch { refused = true; }
				assert.equal(refused, f.capabilities.refusesAtOpen, "capabilities.refusesAtOpen");
			} finally { d.dispose(); }
		});

		T("N1", "golden fixtures (item 1): the real graph ledgers load through the port, read back line-for-line, and fold to the independent oracle", (b) => {
			const dir = new URL("../fixtures/golden-data/graph/", import.meta.url); // a URL, not .pathname (wrong on Windows)
			const lines = (n: string) => fs.readFileSync(new URL(`${n}.jsonl`, dir), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
			const parse = <T>(n: string) => lines(n).map((l) => JSON.parse(l) as T);
			const [nodes, chains, cov, cps] = [parse<GraphNode>("nodes"), parse<GraphChain>("chains"), parse<CoverageEntry>("coverage"), parse<SessionCheckpoint>("sessions")];
			nodes.forEach((x) => b.graph.appendNode(x)); chains.forEach((x) => b.graph.appendChain(x)); cov.forEach((x) => b.graph.appendCoverage(x)); cps.forEach((x) => b.graph.appendCheckpoint(x));
			assert.deepEqual([nodes.length, chains.length, cov.length, cps.length].map((n) => n > 0), [true, true, true, true], "fixture ledgers must be non-empty");
			assert.deepEqual(b.graph.readNodes().map((x) => JSON.stringify(x)), lines("nodes"), "canonical bytes round-trip byte-identically");
			assert.deepEqual(b.graph.readChains().map((x) => JSON.stringify(x)), lines("chains"));
			const g = getGraph(b.graph);
			eq(g.nodes.map((n) => [n.id, n.aliases, n.provenance]), oracleNodes(nodes).map((n) => [n.id, n.aliases, n.provenance]));
			eq(g.chains, oracleChains(chains));
		}, { runs: 1 }); // constant input: extra runs only repeat the same fixture load (lh-jg9)

		P("N2", "corrupt lines are skipped AND counted by corruptLines() (item 2)", fc.array(fc.oneof(A.nodeLine.map((v) => ({ v })), A.garbage.map((g) => ({ g }))), { maxLength: 10 }), (b, items) => {
			for (const it2 of items) "v" in it2 ? b.graph.appendNode(it2.v) : b.hooks.injectCorruptLine("nodes", it2.g);
			eq(b.graph.readNodes(), items.flatMap((x) => ("v" in x ? [x.v] : [])));
			const cl = need(corruptOf(b), "GraphStore.corruptLines");
			eq(cl(), items.filter((x) => "g" in x).length);
		}, f.capabilities.corruptLines ? {} : { todo: "lh-bhc" });

		it("N3 a newer-format store is refused AT OPEN with a StorageVersionError (item 5)", { timeout: A.PROPERTY_TIMEOUT_MS, ...(f.capabilities.refusesAtOpen ? {} : { todo: "lh-bzn" }) }, async () => {
			const b = await fresh();
			try {
				b.hooks.stampNewerFormat();
				await assert.rejects(reopen(f, b), (e: Error) => { assert.equal(e.name, "StorageVersionError"); assert.match(e.message, /\d/); return true; });
			} finally { b.dispose(); }
		});

		P("N4", "re-running an import is idempotent as a multiset (item 6): the first import's lines stay a prefix, the second adds exactly the same lines again", fc.tuple(fc.array(A.nodeLine, { maxLength: 8 }), fc.array(A.saneChainLine, { maxLength: 6 })), (b, [ns, cs]) => {
			// shortcut: the fold itself is not idempotent on duplicate lines (a duplicate adds the statement as an alias), so only the stored multiset is asserted.
			putAll(b, ns, cs);
			const [n1, c1] = [b.graph.readNodes(), b.graph.readChains()];
			putAll(b, ns, cs);
			eq(b.graph.readNodes(), [...n1, ...n1]);
			eq(b.graph.readChains(), [...c1, ...c1]);
		});

		P("N5", "order (item 15): append, rewrite, append keeps call order, inside and outside a transact", fc.tuple(count, count), (b, [x, y]) => {
			const first = Array.from({ length: x }, (_, i) => nodeAt(i));
			const last = Array.from({ length: y }, (_, i) => nodeAt(100 + i));
			b.graph.transact("order", () => { first.forEach((n) => b.graph.appendNode(n)); b.graph.rewriteLedgers({ nodes: first.slice(1) }); last.forEach((n) => b.graph.appendNode(n)); });
			eq(b.graph.readNodes(), [...first.slice(1), ...last]);
		});

		P("N6", "read-your-writes (item 14): inside transact every read sees committed state plus the pending writes, across all ledgers", fc.tuple(fc.array(A.nodeLine, { maxLength: 4 }), fc.array(A.nodeLine, { minLength: 1, maxLength: 4 }), fc.array(A.coverageLine, { maxLength: 3 })), (b, [committed, pending, cov]) => {
			putAll(b, committed);
			b.graph.transact("ryw", () => {
				pending.forEach((n, i) => { b.graph.appendNode(n); eq(b.graph.readNodes(), [...committed, ...pending.slice(0, i + 1)]); });
				cov.forEach((e) => b.graph.appendCoverage(e)); eq(b.graph.readCoverage(), cov);
				b.graph.upsertSource(src("src_1")); eq(b.graph.readSources().map((s) => s.id), ["src_1"]);
				b.graph.rewriteLedgers({ nodes: pending }); eq(b.graph.readNodes(), pending);
				eq(getGraph(b.graph).nodes.length, new Set(pending.map((n) => n.id)).size);
			});
			eq(b.graph.readNodes(), pending);
		});

		P("N7", "revision (item 9): unchanged by reads, no-op rewrites and no-op bare writes; changed by every committed write (source organization included); not changed by a rolled-back transact", count, (b, n) => {
			const rev = need(revisionOf(b), "GraphStore.revision");
			const r0 = rev(); b.graph.readNodes(); b.graph.readChains(); assert.equal(rev(), r0, "a read moved the revision");
			b.graph.appendNode(nodeAt(n)); const r1 = rev(); assert.notEqual(r1, r0, "an append did not move the revision");
			b.graph.rewriteLedgers({ nodes: b.graph.readNodes() }); assert.equal(rev(), r1, "a rewrite to identical content moved the revision");
			b.graph.deleteSources(new Set(["src_none"])); assert.equal(rev(), r1, "a no-op deleteSources moved the revision");
			b.graph.upsertSource(src("src_1")); const r2 = rev(); assert.notEqual(r2, r1);
			b.graph.appendSourceUsage("src_1", usage(1)); const r3 = rev(); assert.notEqual(r3, r2);
			b.graph.appendSourceUsage("src_1", usage(1)); assert.equal(rev(), r3, "a duplicate appendSourceUsage (idempotent per startedAt) moved the revision");
			const orgA = { version: 1, folders: [{ id: "f1", name: "A", parentId: null, createdAt: "t" }], placements: {} } as never;
			const orgB = { version: 1, folders: [{ id: "f1", name: "B", parentId: null, createdAt: "t" }], placements: {} } as never;
			b.sourceOrg.write(orgA); const r4 = rev(); assert.notEqual(r4, r3, "a source-organization write did not move the revision");
			b.sourceOrg.write(orgA); assert.equal(rev(), r4, "an identical source-organization write moved the revision");
			b.sourceOrg.write(orgB); const r5 = rev(); assert.notEqual(r5, r4, "a changed source-organization write (same tick as the last) did not move the revision");
			assert.throws(() => b.graph.transact("rb", () => { b.graph.appendNode(nodeAt(n + 1)); b.sourceOrg.write(orgA); throw new Error("boom"); }), /boom/);
			assert.equal(rev(), r5, "a rolled-back transact moved the revision");
		}, f.capabilities.revision ? {} : { todo: "lh-hbv" });

		P("N8", "rollback (items 4, 17): a throw leaves no lines, no rewrite and no events; a CAUGHT inner throw still rolls the outer transact back", count, (b, n) => {
			b.graph.appendNode(nodeAt(0));
			const before = everything(b);
			const ev = events(b);
			try {
				assert.throws(() => b.graph.transact("t1", () => { for (let i = 1; i <= n; i++) b.graph.appendNode(nodeAt(i)); b.graph.rewriteLedgers({ chains: [] }); b.sourceOrg.write(org); throw new Error("boom"); }), /boom/);
				assert.equal(everything(b), before);
				assert.throws(() => b.graph.transact("outer", () => {
					b.graph.appendNode(nodeAt(50));
					try { b.graph.transact("inner", () => { b.graph.appendNode(nodeAt(51)); throw new Error("inner"); }); } catch { /* caught on purpose */ }
					b.graph.appendNode(nodeAt(52));
				}));
				assert.equal(everything(b), before, "outer committed although a nested transact threw");
				assert.deepEqual(ev.seen, [], "events fired inside a rolled-back transact");
			} finally { ev.off(); }
		});

		P("N9", "events after commit (item 10): the source-organization event fires once, only after every op flushed, never from a rolled-back transact", count, (b, n) => {
			const seenAtEvent: string[] = [];
			const off = b.events.subscribe((e) => { if (e.type === "sources-changed") seenAtEvent.push(JSON.stringify([b.graph.readNodes().length, b.sourceOrg.read().folders.length])); });
			try {
				b.graph.transact("commit", () => { b.sourceOrg.write(org); for (let i = 0; i < n; i++) b.graph.appendNode(nodeAt(i)); assert.deepEqual(seenAtEvent, [], "event fired before commit"); });
				eq(seenAtEvent, [JSON.stringify([n, 1])]);
			} finally { off(); }
		});

		P("N10", "nested transact (item 11) joins the outer: one commit, call order kept", count, (b, n) => {
			b.graph.transact("outer", () => { b.graph.appendNode(nodeAt(0)); b.graph.transact("inner", () => { for (let i = 1; i <= n; i++) b.graph.appendNode(nodeAt(i)); }); b.graph.appendNode(nodeAt(99)); });
			eq(b.graph.readNodes().map((x) => x.statement), ["s0", ...Array.from({ length: n }, (_, i) => `s${i + 1}`), "s99"]);
		});

		// Item 10 for adapters that emit: the listener runs when the event fires, so what it can read shows whether the write came first.
		T("N17", "events after the write (item 10): chats-changed fires once, and a listener already sees the new chat", (b) => {
			const seen: number[] = [];
			const off = b.events.subscribe((e) => { if (e.type === "chats-changed") seen.push(b.chats.listChats().length); });
			try { b.chats.createChat("a"); } finally { off(); }
			assert.deepEqual(seen, [1]);
		}, { runs: 1 }); // constant input: one run is enough (lh-1oo)
		T("N18", "events after the write (item 10): jobs-changed fires once, and a listener already sees the new job", (b) => {
			const seen: number[] = [];
			const off = b.events.subscribe((e) => { if (e.type === "jobs-changed") seen.push(b.jobs.listJobs("c1").length); });
			try { b.jobs.createJob({ kind: "probe", chatId: "c1", toolCallId: "t1" } as never); } finally { off(); }
			assert.deepEqual(seen, [1]);
		}, { runs: 1 }); // constant input: one run is enough (lh-1oo)

		T("N11", "positions and render settings stay OUTSIDE the transaction (item 13): they survive a rollback", (b) => {
			const raw = b.render.read();
			assert.equal(raw, null);
			let written: unknown;
			assert.throws(() => b.graph.transact("t", () => { b.graph.writePositions({ n1: { x: 1, y: 2 } }); written = b.render.write({}); b.graph.appendNode(nodeAt(0)); throw new Error("boom"); }), /boom/);
			eq(b.graph.readPositions(), { n1: { x: 1, y: 2 } });
			eq(b.render.read(), written);
			eq(b.graph.readNodes(), []);
		}, { runs: 1 }); // constant input: one run is enough (lh-1oo)

		P("N12", "bare writes (item 16): upsertSource, appendSourceUsage, deleteSources and the organization write are each atomic and idempotent where documented", fc.array(fc.constantFrom("a", "b", "c"), { minLength: 1, maxLength: 5 }), (b, ids) => {
			const ev = events(b);
			try {
				for (const id of ids) b.graph.upsertSource(src(`src_${id}`));
				const uniq = [...new Set(ids)].map((x) => `src_${x}`).sort();
				eq(b.graph.readSources().map((s) => s.id).sort(), uniq);
				b.graph.appendSourceUsage(uniq[0]!, usage(7)); b.graph.appendSourceUsage(uniq[0]!, usage(7));
				eq(b.graph.readSources().find((s) => s.id === uniq[0])!.extractions?.length, 1);
				b.graph.upsertSource(src(uniq[0]!)); assert.equal(b.graph.readSources().find((s) => s.id === uniq[0])!.extractions?.length, 1, "an upsert must keep the usage log");
				eq(b.graph.deleteSources(new Set(["src_none"])), 0);
				eq(b.graph.deleteSources(new Set(uniq)), uniq.length);
				eq(b.graph.readSources(), []);
				b.sourceOrg.write(org); eq(b.sourceOrg.read(), org);
				assert.ok(ev.seen.includes("sources-changed"));
			} finally { ev.off(); }
		});

		T("N13", "failure modes (item 17): an async fn rolls back and throws; work after its first await is not undone", (b) => {
			const before = everything(b);
			assert.throws(() => b.graph.transact("async", (() => { b.graph.appendNode(nodeAt(0)); return Promise.resolve(1); }) as never), TypeError);
			assert.equal(everything(b), before);
		}, { runs: 1 }); // constant input: one run is enough (lh-1oo)


		P("N15", "round trip with defined normalisation (item 12): CRLF becomes LF, blank lines and a torn tail are dropped; unknown fields, whitespace and key order are kept", fc.tuple(fc.array(fc.tuple(A.verbatimNode, fc.constantFrom("lf", "crlf", "blank-before")), { maxLength: 8 }), fc.constantFrom('{"id":"n9","na', '{', '[1,')), (b, [items, torn]) => {
			for (const [n, style] of items) {
				if (style === "blank-before") b.hooks.injectCorruptLine("nodes", "");
				if (style === "crlf") b.hooks.injectCorruptLine("nodes", `${JSON.stringify(n)}\r`); else b.graph.appendNode(n);
			}
			b.hooks.injectTornTail?.("nodes", torn);
			const expected = items.map(([n]) => n);
			assert.equal(JSON.stringify(b.graph.readNodes()), JSON.stringify(expected));
		});

		P("N16", "export(import(export(x))) == export(x), byte-for-byte, over all four ledgers with verbatim records (item 12)", fc.tuple(fc.array(A.verbatimNode, { maxLength: 6 }), fc.array(A.verbatimChain, { maxLength: 6 }), fc.array(A.verbatimCoverage, { maxLength: 4 }), fc.array(A.verbatimCheckpoint, { maxLength: 4 })), async (b, [ns, cs, cv, cp]) => {
			ns.forEach((x) => b.graph.appendNode(x)); cs.forEach((x) => b.graph.appendChain(x)); cv.forEach((x) => b.graph.appendCoverage(x)); cp.forEach((x) => b.graph.appendCheckpoint(x));
			const e1 = exportAll(b);
			assert.equal(e1, JSON.stringify([ns, cs, cv, cp]), "export differs from what was written");
			const [rn, rc, rv, rp] = [b.graph.readNodes(), b.graph.readChains(), b.graph.readCoverage(), b.graph.readCheckpoints()]; // read BEFORE opening b2: some adapters bind one folder at a time
			const b2 = await fresh();
			try {
				rn.forEach((x) => b2.graph.appendNode(x)); rc.forEach((x) => b2.graph.appendChain(x)); rv.forEach((x) => b2.graph.appendCoverage(x)); rp.forEach((x) => b2.graph.appendCheckpoint(x));
				assert.equal(exportAll(b2), e1);
			} finally { b2.dispose(); }
		});
	});

	void 0;
}

/** J. Cross-adapter equivalence: identical raw-op traces on two adapters give identical reads and folds. */
export function registerEquivalence(a: AdapterFactory, bf: AdapterFactory): void {
	describe(`${a.name} vs ${bf.name}: J cross-adapter equivalence`, () => {
		type Op = { t: "n"; v: GraphNode } | { t: "c"; v: GraphChain } | { t: "cov"; v: CoverageEntry } | { t: "cp"; v: SessionCheckpoint } | { t: "bad"; g: string } | { t: "rw"; mask: boolean[] };
		const op: fc.Arbitrary<Op> = fc.oneof(A.nodeLine.map((v) => ({ t: "n", v }) as Op), A.chainLine.map((v) => ({ t: "c", v }) as Op), A.coverageLine.map((v) => ({ t: "cov", v }) as Op), A.checkpointLine.map((v) => ({ t: "cp", v }) as Op), A.garbage.map((g) => ({ t: "bad", g }) as Op), fc.array(fc.boolean(), { maxLength: 20 }).map((mask) => ({ t: "rw", mask }) as Op));
		const run = async (fa: AdapterFactory, ops: Op[]) => {
			const b = await openFresh(fa); const trace: unknown[] = [];
			try {
				for (const o of ops) {
					if (o.t === "n") b.graph.appendNode(o.v); else if (o.t === "c") b.graph.appendChain(o.v); else if (o.t === "cov") b.graph.appendCoverage(o.v); else if (o.t === "cp") b.graph.appendCheckpoint(o.v);
					else if (o.t === "bad") b.hooks.injectCorruptLine("nodes", o.g);
					else b.graph.rewriteLedgers({ chains: b.graph.readChains().filter((_, i) => o.mask[i % Math.max(1, o.mask.length)] ?? true) });
					trace.push(JSON.stringify([b.graph.readNodes(), b.graph.readChains(), b.graph.readCoverage(), b.graph.readCheckpoints(), getGraph(b.graph)]));
				}
				return trace;
			} finally { b.dispose(); }
		};
		it("J1 same op sequence => byte-identical raw lines and equal folded graph after every step", () => fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 20 }), async (ops) => { eq(await run(a, ops), await run(bf, ops)); }), A.cfg));
	});
}

// ── mergeFindings driver ────────────────────────────────────────────────────
interface Step { chatId: string; props: { name: string; statement: string; aliases: string[]; messageId?: string; link?: number }[]; chains: { prem: number[]; conc: number }[]; cov?: CoverageEntry[] }
function stepArb(): fc.Arbitrary<Step> {
	const text = fc.constantFrom("", "s1", "s2", "a1", "a2");
	return fc.record({
		chatId: fc.constantFrom("c1", "c2", "src_1"),
		props: fc.array(fc.record({ name: text, statement: text, aliases: fc.array(text, { maxLength: 2 }), messageId: fc.option(fc.constantFrom("m1", "m2"), { nil: undefined }), link: fc.option(fc.nat(6), { nil: undefined }) }, { requiredKeys: ["name", "statement", "aliases"] }), { maxLength: 4 }),
		chains: fc.array(fc.record({ prem: fc.array(fc.nat(8), { maxLength: 3 }), conc: fc.nat(8) }), { maxLength: 4 }),
		cov: fc.option(fc.array(A.coverageLine, { maxLength: 2 }), { nil: undefined }),
	}, { requiredKeys: ["chatId", "props", "chains"] });
}
function runStep(deps: { chatStore: unknown; graphStore: GraphStore }, s: Step) {
	const existing = [...new Set(deps.graphStore.readNodes().map((n) => n.id))];
	const locals = s.props.map((_, i) => `p${i}`);
	const pool = [...locals, ...existing, "n_bogus"];
	const at = (i: number) => pool[i % pool.length]!;
	const links = s.props.flatMap((p, i) => (p.link === undefined ? [] : [{ id: `p${i}`, linkTo: p.link % (existing.length + 1) === existing.length ? "n_bogus" : existing[p.link % (existing.length + 1)]! }]));
	return mergeFindings(
		s.chatId,
		{ propositions: s.props.map((p, i) => ({ id: `p${i}`, name: p.name, statement: p.statement, aliases: p.aliases, ...(p.messageId ? { messageId: p.messageId } : {}) })), chains: s.chains.map((c) => ({ premises: c.prem.map(at), conclusion: at(c.conc) })) } as never,
		{ links },
		deps as never,
		{ foldedAt: "2026-01-01T00:00:00.000Z", ...(s.cov ? { coverage: s.cov } : {}) },
	);
}
import { createHash } from "node:crypto";
function require_sha256(buf: Buffer): string { return createHash("sha256").update(buf).digest("hex"); }

// ── registration: every adapter found by glob, plus pairwise equivalence ──
const adapters = await discoverAdapters();
test("discovery found this contract file and at least one adapter", () => {
	assert.ok(adapters.length >= 1, "no adapter factory found in tests/contract/adapters");
	assert.equal(new Set(adapters.map((a) => a.name)).size, adapters.length, "adapter names must be unique");
});
for (const a of adapters) registerContract(a);
// shortcut: with one adapter J compares it to itself (validates the harness only); real J starts at the second adapter.
// shortcut: J1 compares two adapters, so it registers nothing until a second adapter exists (a self-comparison is not evidence).
for (const [i, a] of adapters.entries()) for (const b of adapters.slice(i + 1)) registerEquivalence(a, b);
