/**
 * Model-based stateful tests (lh-o0a): fc.commands drives random op sequences against every discovered
 * adapter and an independent in-memory model, comparing the full observable state after EVERY step.
 * Shrunk counterexamples are saved in model/regressions.json and replayed on every run.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import fc from "fast-check";
import * as A from "./harness.ts";
import { discoverAdapters } from "./harness.ts";
import type { AdapterFactory } from "./harness.ts";
import { Cmd, closeReal, commandArb, exec, openReal, type Spec } from "./model/commands.ts";
import { Model } from "./model/reference.ts";
import "./model/sql-failpoints.ts";

/** adapter name -> test id -> owning bead. Per adapter, never global. Empty: the model found no gap. */
const MODEL_GAPS: Record<string, Record<string, string>> = {};

const regressions = JSON.parse(fs.readFileSync(new URL("./model/regressions.json", import.meta.url), "utf8")) as { name: string; why: string; specs: Spec[] }[];
const MAX_COMMANDS = Number(process.env.FC_MODEL_COMMANDS ?? 20);
const modelCfg: fc.Parameters<unknown> = { ...A.cfg, numRuns: Math.min(A.runs, Number(process.env.FC_MODEL_RUNS ?? 60)) };

async function replay(f: AdapterFactory, specs: Spec[]): Promise<void> {
	const r = await openReal(f);
	try {
		const m = new Model();
		for (const s of specs) await exec(s, m, r);
	} finally { closeReal(r); }
}

for (const f of await discoverAdapters()) {
	const gap = MODEL_GAPS[f.name]?.["MB1"];
	describe(`${f.name}: M model-based stateful`, () => {
		it("MB1 random append/rewrite/transact/throw/reopen sequences match the in-memory model after every step", { timeout: A.PROPERTY_TIMEOUT_MS, ...(gap ? { todo: gap } : {}) }, async () => {
			await fc.assert(fc.asyncProperty(fc.commands(
				[commandArb], { maxCommands: MAX_COMMANDS }), async (cmds) => {
				const r = await openReal(f);
				try { await fc.asyncModelRun(() => ({ model: new Model(), real: r }), cmds); } finally { closeReal(r); }
			}), modelCfg);
		});

		it("MB3 rewrite with modified copies of the kept lines leaves exactly those copies, in order, across a reopen", { timeout: A.PROPERTY_TIMEOUT_MS }, async () => {
			const all = { keep: [true], rev: false, mod: true };
			await fc.assert(fc.asyncProperty(fc.array(fc.oneof(A.nodeLine.map((v) => ({ k: "append", op: { t: "n", v } }) as Spec), A.chainLine.map((v) => ({ k: "append", op: { t: "c", v } }) as Spec)), { maxLength: 8 }), async (appends) => {
				await replay(f, [...appends, { k: "rewrite", spec: { nodes: all, chains: all, coverage: all, checkpoints: all } }, { k: "reopen" }, { k: "rewrite", spec: { nodes: { ...all, rev: true } } }]);
			}), modelCfg);
		});

		it("MB2 regression seeds (shrunk counterexamples) replay clean", { timeout: A.PROPERTY_TIMEOUT_MS }, async () => {
			assert.ok(regressions.length > 0, "regressions.json is empty: seed it with a shrunk counterexample");
			for (const g of regressions) { assert.ok(g.specs.length > 0 && g.why, `${g.name}: needs specs and why`); await replay(f, g.specs); }
		});
	});
}
// Adapter-level crash atomicity: registered `todo` so the matrix row cannot pass silently (S5 / D3 replace the body).
describe("SQL adapters: crash atomicity through the GraphStore", () => {
	it("FP-SQLAD-CRASH sqlite GraphStore: a crash at every write step of a transact leaves no trace", { todo: "lh-bhc" }, () => { throw new Error("pending: sqlite GraphStore (S5)"); });
	it("FP-DOLT-CRASH doltlite GraphStore: a crash at every write step of a transact leaves no trace and no commit", { todo: "lh-bkg" }, () => { throw new Error("pending: doltlite GraphStore (D3)"); });
});
void Cmd;
