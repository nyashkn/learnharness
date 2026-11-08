/**
 * The storage contract, as properties. Categories (see MATRIX.md):
 *  A fold semantics   B append/read round-trip   C rewriteLedgers   D transact atomicity
 *  E coverage ledger  F simplify/merge invariants G format guard     H record round-trips
 *  I ordering/identity J cross-adapter equivalence
 * Test names start with their id (A1, B3 ...). Tests whose failure is a confirmed
 * upstream gap are in KNOWN and run as node:test `todo` (they still execute and report).
 */
import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import fc from "fast-check";
import * as A from "./harness.ts";
import { discoverAdapters, openFresh } from "./harness.ts";
import type { AdapterFactory, Ledger, StoreBundle } from "./harness.ts";
import { getGraph, mergeFindings, simplifyChains } from "../../src/core/graph.ts";
import { coveredSet } from "../../src/core/coverage.ts";
import type { CoverageEntry, GraphChain, GraphNode, SessionCheckpoint } from "../../src/core/contracts.ts";
import type { GraphStore } from "../../src/core/ports.ts";

/** Test id -> upstream finding (contract-tests FINDINGS.md). Listed tests run as node:test `todo`: they execute and report but do not fail the run. */
const KNOWN: Record<string, string> = {
	"B4-nodes": "FINDING-1 torn append swallows next append", "B4-chains": "FINDING-1", "B4-checkpoints": "FINDING-1", "E5": "FINDING-1",
	"D1": "FINDING-2 known gap, PR0 (no transact)",
	"F5": "FINDING-3",
	"F3c": "FINDING-4 out-of-domain input",
	"G2": "FINDING-5",
	"H10b": "FINDING-6 latent, unreachable ids",
};


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
	const P = <T>(id: string, title: string, arb: fc.Arbitrary<T>, fn: (b: StoreBundle, v: T) => void | Promise<void>, opts: { skip?: string } = {}) => {
		const name = `${id} ${title}`;
		const o = opts.skip ? { skip: opts.skip } : KNOWN[id] ? { todo: `known: ${KNOWN[id]}` } : {};
		it(name, o, () => fc.assert(fc.asyncProperty(arb, async (v) => { const b = await fresh(); try { await fn(b, v); } finally { b.dispose(); } }), A.cfg));
	};
	const T = (id: string, title: string, fn: (b: StoreBundle) => void) => P(id, title, fc.constant(0), (b) => fn(b));
	const PEND = (why: string) => (f.capabilities.transact ? undefined : `pending: ${why}`);

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
			const b2 = await fresh(); putAll(b2, regrouped);
			for (const n of getGraph(b2.graph).nodes) eq(n, base.get(n.id));
		});
		P("A7", "fold is deterministic and does not mutate the ledger", lines, (b, ls) => {
			putAll(b, ls);
			const s0 = state(b.graph);
			eq(getGraph(b.graph), getGraph(b.graph));
			eq(state(b.graph), s0);
		});
	});

	describe(`${f.name}: B append/read round-trip`, () => {
		const ledgers: { l: Ledger; arb: fc.Arbitrary<unknown>; app: (b: StoreBundle, v: any) => void; rd: (b: StoreBundle) => unknown[] }[] = [
			{ l: "nodes", arb: A.nodeLine, app: (b, v) => b.graph.appendNode(v), rd: (b) => b.graph.readNodes() },
			{ l: "chains", arb: A.chainLine, app: (b, v) => b.graph.appendChain(v), rd: (b) => b.graph.readChains() },
			{ l: "checkpoints", arb: A.checkpointLine, app: (b, v) => b.graph.appendCheckpoint(v), rd: (b) => b.graph.readCheckpoints() },
		];
		for (const L of ledgers) {
			const lines = fc.array(L.arb, { maxLength: 10 });
			P(`B1-${L.l}`, "append then read returns the same lines in append order", lines, (b, ls) => { ls.forEach((v) => L.app(b, v)); eq(L.rd(b), ls); });
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
		const fault = (g: GraphStore, failAt: number): GraphStore => {
			let n = 0;
			const MUT = new Set(["appendNode", "appendChain", "appendCheckpoint", "appendCoverage", "rewriteLedgers"]);
			return new Proxy(g, { get: (t: any, p: string) => { const v = t[p]; if (typeof v !== "function") return v; return MUT.has(p) ? (...a: any[]) => { if (++n === failAt) throw new Error("injected"); return v.apply(t, a); } : v.bind(t); } });
		};
		P("D1", "TODAY (no transact): mergeFindings that throws mid-way leaves NO change", fc.tuple(stepArb(), stepArb(), fc.integer({ min: 1, max: 12 })), (b, [s1, s2, k]) => {
			const deps0 = { chatStore: b.chats, graphStore: b.graph };
			runStep(deps0, s1);
			const before = state(b.graph);
			let threw = false;
			try { runStep({ chatStore: b.chats, graphStore: fault(b.graph, k) }, s2); } catch { threw = true; }
			if (threw) eq(state(b.graph), before);
		});
		type TOp = { t: "n"; v: GraphNode } | { t: "c"; v: GraphChain } | { t: "cov"; v: CoverageEntry } | { t: "rw" };
		const tops = fc.array(fc.oneof(A.nodeLine.map((v) => ({ t: "n", v }) as TOp), A.chainLine.map((v) => ({ t: "c", v }) as TOp), A.coverageLine.map((v) => ({ t: "cov", v }) as TOp), fc.constant({ t: "rw" } as TOp)), { maxLength: 8 });
		P("D2", "MODEL: transact(fn) commits all ops when fn returns (and returns fn's value); a throw at ANY point leaves state identical to before and rethrows", fc.array(fc.record({ ops: tops, throwAt: fc.option(fc.nat(8), { nil: undefined }) }), { maxLength: 6 }), (b, txs) => {
			const m: any = { nodes: [], chains: [], coverage: [] };
			for (const tx of txs) {
				const before = state(b.graph);
				const staged = structuredClone(m);
				let threw = false;
				try {
					const r = b.transact!("t", () => {
						tx.ops.forEach((o, i) => {
							if (tx.throwAt === i) throw new Error("boom");
							if (o.t === "n") { b.graph.appendNode(o.v); staged.nodes.push(o.v); }
							if (o.t === "c") { b.graph.appendChain(o.v); staged.chains.push(o.v); }
							if (o.t === "cov") { b.graph.appendCoverage(o.v); staged.coverage.push(o.v); }
							if (o.t === "rw") { staged.chains = staged.chains.slice(1); b.graph.rewriteLedgers({ chains: staged.chains }); }
						});
						if (tx.throwAt !== undefined && tx.throwAt >= tx.ops.length) throw new Error("boom");
						return 42;
					});
					eq(r, 42);
					Object.assign(m, staged);
				} catch { threw = true; }
				if (threw) eq(state(b.graph), before);
				else eq([b.graph.readNodes(), b.graph.readChains(), b.graph.readCoverage()], [m.nodes, m.chains, m.coverage]);
			}
		}, { skip: PEND("needs PR0 (GraphStore.transact)") });
		P("D3", "mergeFindings run inside transact is atomic under a fault at every write position (incl. the simplify rewrite and coverage appends)", fc.tuple(stepArb(), stepArb(), fc.integer({ min: 1, max: 14 })), (b, [s1, s2, k]) => {
			runStep({ chatStore: b.chats, graphStore: b.graph }, s1);
			const before = state(b.graph);
			try { b.transact!("merge", () => runStep({ chatStore: b.chats, graphStore: fault(b.graph, k) }, s2)); } catch { eq(state(b.graph), before); }
		}, { skip: PEND("needs PR0 (GraphStore.transact)") });
		P("D4", "one durable commit per transact (engine fact for versioned back-ends)", fc.constant(0), () => {}, { skip: "pending: needs PR6 (DoltLite driver; assert commit count via dolt_log)" });
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

	describe(`${f.name}: G format-version guard`, () => {
		const reads = (b: StoreBundle): [string, () => unknown][] => [
			["readNodes", () => b.graph.readNodes()], ["readChains", () => b.graph.readChains()], ["readCheckpoints", () => b.graph.readCheckpoints()],
			["readCoverage", () => b.graph.readCoverage()], ["readSources", () => b.graph.readSources()], ["sourceOrg.read", () => b.sourceOrg.read()], ["render.read", () => b.render.read()],
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

	// ── New contract items: todo until the owning bead lands the API (they execute and report, never fail the run) ──
	describe(`${f.name}: N pending contract items`, () => {
		const nodeAt = (i: number): GraphNode => ({ id: `n${(i % 5) + 1}`, name: "", statement: `s${i}`, aliases: [], createdAt: "t", provenance: [] });
		const need = <T>(v: T | undefined, what: string): T => { if (v === undefined) throw new Error(`pending: ${what} not implemented`); return v; };
		const N = <T>(id: string, bead: string, title: string, arb: fc.Arbitrary<T>, fn: (b: StoreBundle, v: T) => void) => {
			it(`${id} ${title}`, { todo: bead }, () => fc.assert(fc.asyncProperty(arb, async (v) => { const b = await fresh(); try { fn(b, v); } finally { b.dispose(); } }), { ...A.cfg, numRuns: 20 }));
		};
		N("N1", "lh-7lz", "order: a committed transact appends lines in call order", fc.integer({ min: 1, max: 8 }), (b, n) => {
			const ns = Array.from({ length: n }, (_, i) => nodeAt(i));
			need(b.transact, "GraphStore.transact")("n1", () => ns.forEach((x) => b.graph.appendNode(x)));
			eq(b.graph.readNodes(), ns);
		});
		N("N2", "lh-7lz", "read-your-writes: inside transact, reads see the transaction's own appends", fc.integer({ min: 1, max: 8 }), (b, n) => {
			need(b.transact, "GraphStore.transact")("n2", () => { for (let i = 0; i < n; i++) { b.graph.appendNode(nodeAt(i)); assert.equal(b.graph.readNodes().length, i + 1); } });
		});
		N("N3", "lh-hbv", "revision changes only when the store changes (reads and no-op rewrites keep it)", fc.integer({ min: 1, max: 6 }), (b, n) => {
			const rev = need((b.graph as unknown as { revision?: () => string }).revision, "GraphStore.revision").bind(b.graph);
			const r0 = rev(); b.graph.readNodes(); b.graph.readChains(); assert.equal(rev(), r0);
			b.graph.appendNode(nodeAt(n)); const r1 = rev(); assert.notEqual(r1, r0);
			b.graph.rewriteLedgers({ chains: b.graph.readChains() }); assert.equal(rev(), r1);
		});
		N("N4", "lh-7lz", "rollback-only: a throwing transact leaves exactly the pre-transaction state", fc.integer({ min: 1, max: 6 }), (b, n) => {
			b.graph.appendNode(nodeAt(0));
			const before = state(b.graph);
			assert.throws(() => need(b.transact, "GraphStore.transact")("n4", () => { for (let i = 1; i <= n; i++) b.graph.appendNode(nodeAt(i)); throw new Error("boom"); }), /boom/);
			assert.equal(state(b.graph), before);
		});
		N("N5", "lh-rws", "round trip: read(write(x)) equals x under the defined normalisation (JSON: undefined keys dropped, key order irrelevant)", A.nodeLine, (b, n) => {
			b.graph.appendNode(n);
			eq(b.graph.readNodes(), [JSON.parse(JSON.stringify(n))]);
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
if (adapters.length === 1) registerEquivalence(adapters[0]!, adapters[0]!);
for (const [i, a] of adapters.entries()) for (const b of adapters.slice(i + 1)) registerEquivalence(a, b);
