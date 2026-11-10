/**
 * fc.commands for the model-based suite (lh-o0a). Every command is plain data (`Spec`), so a shrunk
 * counterexample printed by fast-check is JSON that can be pasted into regressions.json and replayed.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import * as A from "../harness.ts";
import type { AdapterFactory, StoreBundle } from "../harness.ts";
import type { ReviewLine, CoverageEntry, GraphChain, GraphNode, Position, SessionCheckpoint } from "../../../src/core/contracts.ts";
import type { GraphStore } from "../../../src/core/ports.ts";
import { cloneLedgers, Model, remapWouldCycle, resolvedReviews, resolveRewrite, type Ledgers, type Mask, type RewriteSpec } from "./reference.ts";

export type Leaf =
	| { t: "n"; v: GraphNode } | { t: "c"; v: GraphChain } | { t: "cov"; v: CoverageEntry } | { t: "cp"; v: SessionCheckpoint } | { t: "rv"; v: ReviewLine } | { t: "rm"; from: string; to: string }
	| { t: "rw"; spec: RewriteSpec };
export type TxOp = Leaf | { t: "throw" } | { t: "nest"; how: "ok" | "caught" | "propagate"; ops: (Leaf | { t: "throw" })[] };
export type Spec =
	| { k: "append"; op: Exclude<Leaf, { t: "rw" }> }
	| { k: "rewrite"; spec: RewriteSpec }
	| { k: "tx"; ops: TxOp[] }
	| { k: "positions"; p: Record<string, Position> }
	| { k: "render" }
	| { k: "reopen" };

export interface Real { f: AdapterFactory; dir: string; b: StoreBundle }

/** Open a fresh temp folder on the adapter (same naming as harness.openFresh; reopen needs the raw bundle). */
export async function openReal(f: AdapterFactory): Promise<Real> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lh-contract-${f.name}-`));
	return { f, dir, b: await f.open(dir) };
}
export function closeReal(r: Real): void {
	try { r.b.dispose(); } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
}

// ── generators ──
const mask: fc.Arbitrary<Mask> = fc.record({ keep: fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), rev: fc.boolean(), mod: fc.boolean() });
const rewriteSpec: fc.Arbitrary<RewriteSpec> = fc.record({ nodes: mask, chains: mask, coverage: mask, checkpoints: mask }, { requiredKeys: [] });
const leaf: fc.Arbitrary<Leaf> = fc.oneof(
	{ weight: 3, arbitrary: A.nodeLine.map((v) => ({ t: "n", v }) as Leaf) },
	{ weight: 2, arbitrary: A.chainLine.map((v) => ({ t: "c", v }) as Leaf) },
	{ weight: 1, arbitrary: A.coverageLine.map((v) => ({ t: "cov", v }) as Leaf) },
	{ weight: 1, arbitrary: A.checkpointLine.map((v) => ({ t: "cp", v }) as Leaf) },
	{ weight: 2, arbitrary: A.verbatimReview.map((v) => ({ t: "rv", v }) as Leaf) },
	{ weight: 2, arbitrary: fc.record({ from: A.nodeId, to: A.nodeId }).map((x) => ({ t: "rm", ...x }) as Leaf) },
	{ weight: 2, arbitrary: rewriteSpec.map((spec) => ({ t: "rw", spec }) as Leaf) },
);
const innerOp = fc.oneof({ weight: 8, arbitrary: leaf }, { weight: 1, arbitrary: fc.constant({ t: "throw" } as const) });
const txOp: fc.Arbitrary<TxOp> = fc.oneof(
	{ weight: 8, arbitrary: leaf },
	{ weight: 1, arbitrary: fc.constant({ t: "throw" } as TxOp) },
	{ weight: 3, arbitrary: fc.record({ t: fc.constant("nest" as const), how: fc.constantFrom("ok", "caught", "propagate"), ops: fc.array(innerOp, { maxLength: 3 }) }) as fc.Arbitrary<TxOp> },
);
const position = fc.record({ x: fc.integer({ min: -50, max: 50 }), y: fc.integer({ min: -50, max: 50 }) });
export const spec: fc.Arbitrary<Spec> = fc.oneof(
	{ weight: 6, arbitrary: leaf.filter((l): l is Exclude<Leaf, { t: "rw" }> => l.t !== "rw").map((op) => ({ k: "append", op }) as Spec) },
	{ weight: 3, arbitrary: rewriteSpec.map((s) => ({ k: "rewrite", spec: s }) as Spec) },
	{ weight: 5, arbitrary: fc.array(txOp, { maxLength: 6 }).map((ops) => ({ k: "tx", ops }) as Spec) },
	{ weight: 1, arbitrary: fc.dictionary(A.nodeId, position).map((p) => ({ k: "positions", p }) as Spec) },
	{ weight: 1, arbitrary: fc.constant({ k: "render" } as Spec) },
	{ weight: 1, arbitrary: fc.constant({ k: "reopen" } as Spec) },
);

// ── execution ──
const KEY = { n: "nodes", c: "chains", cov: "coverage", cp: "checkpoints", rv: "reviews" } as const;
const APPEND: Record<string, (g: GraphStore, v: never) => void> = {
	n: (g, v) => g.appendNode(v), c: (g, v) => g.appendChain(v), cov: (g, v) => g.appendCoverage(v), cp: (g, v) => g.appendCheckpoint(v), rv: (g, v) => g.appendReview(v),
};
const same = (g: GraphStore) => JSON.stringify([g.readNodes(), g.readChains(), g.readCoverage(), g.readCheckpoints(), g.readReviews()]);
const lines = (l: Ledgers) => JSON.stringify([l.nodes, l.chains, l.coverage, l.checkpoints, resolvedReviews(l)]);

interface Ctx { poisoned: boolean; threw: boolean }

/** Run ops on the real store while `work` (a model copy) follows along; after every op the store must read as `work` (read-your-writes). */
function runOps(g: GraphStore, work: Model, ops: TxOp[], ctx: Ctx): void {
	for (const op of ops) {
		if (op.t === "throw") { ctx.threw = true; throw new Error("boom"); }
		if (op.t === "nest") {
			if (op.how === "ok") g.transact("in", () => runOps(g, work, op.ops, ctx));
			else if (op.how === "propagate") g.transact("in", () => { runOps(g, work, op.ops, ctx); ctx.threw = true; throw new Error("inner"); });
			else { try { g.transact("in", () => { runOps(g, work, op.ops, ctx); throw new Error("inner"); }); } catch { /* caught on purpose */ } ctx.poisoned = true; }
			continue;
		}
		applyLeaf(g, work, op);
		assert.equal(same(g), lines(work.led), `read-your-writes broke after ${JSON.stringify(op)}`);
	}
}
function applyLeaf(g: GraphStore, work: Model, op: Leaf): void {
	if (op.t === "rw") {
		const next = resolveRewrite(work.led, op.spec);
		g.rewriteLedgers(next);
		work.rewrite(next);
	} else if (op.t === "rm") {
		if (remapWouldCycle(work.led.reviewRemaps, op.from, op.to)) assert.throws(() => g.remapReviewTargets(op.from, op.to), /cycle/); // refused, nothing written, the transaction is not poisoned
		else { g.remapReviewTargets(op.from, op.to); work.led.reviewRemaps.push({ from: op.from, to: op.to }); }
	} else {
		APPEND[op.t]!(g, op.v as never);
		work.append(KEY[op.t], op.v as never);
	}
}

function observed(r: Real): string {
	const g = r.b.graph;
	const pos = Object.fromEntries(Object.entries(g.readPositions()).sort(([a], [b]) => a.localeCompare(b)));
	return JSON.stringify([g.readNodes(), g.readChains(), g.readCoverage(), g.readCheckpoints(), g.readReviews(), pos, r.b.render.read()]);
}

export async function exec(s: Spec, m: Model, r: Real): Promise<void> {
	const g = r.b.graph;
	switch (s.k) {
		case "append": applyLeaf(g, m, s.op); break;
		case "rewrite": applyLeaf(g, m, { t: "rw", spec: s.spec }); break;
		case "positions": g.writePositions(s.p); m.positions = structuredClone(s.p); break;
		case "render": m.render = structuredClone(r.b.render.write({})); break;
		case "reopen": r.b.dispose(); r.b = await r.f.open(r.dir); break;
		case "tx": {
			const work = new Model();
			work.led = cloneLedgers(m.led);
			const ctx: Ctx = { poisoned: false, threw: false };
			let thrown = false;
			try { g.transact("model", () => runOps(g, work, s.ops, ctx)); } catch (e) { thrown = true; if (e instanceof assert.AssertionError) throw e; }
			assert.equal(thrown, ctx.poisoned || ctx.threw, ctx.poisoned && !thrown ? "a caught nested throw must still roll the outer transact back" : "transact threw/returned against the model");
			if (!thrown) m.led = work.led;
		}
	}
	assert.equal(observed(r), m.snapshot(), `store differs from model after ${JSON.stringify(s)}`);
}

export class Cmd implements fc.AsyncCommand<Model, Real, false> {
	constructor(readonly s: Spec) {}
	check = () => true;
	async run(m: Model, r: Real): Promise<void> { await exec(this.s, m, r); }
	toString = () => JSON.stringify(this.s);
}
export const commandArb = spec.map((s) => new Cmd(s));
