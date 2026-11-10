/**
 * Model-based stateful tests (lh-o0a): fc.commands drives random op sequences against every discovered
 * adapter and an independent in-memory model, comparing the full observable state after EVERY step.
 * Shrunk counterexamples are saved in model/regressions.json and replayed on every run.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import fc from "fast-check";
import * as A from "./harness.ts";
import { discoverAdapters } from "./harness.ts";
import type { AdapterFactory } from "./harness.ts";
import { Cmd, closeReal, commandArb, exec, openReal, type Spec } from "./model/commands.ts";
import { Model } from "./model/reference.ts";
import { faultyDriver, InjectedFault, type Fault, type FaultyDriver } from "../../src/store/sql/drivers/faulty.ts";
import { openDoltlite } from "../../src/store/sql/drivers/doltlite.ts";
import { openGraphStore } from "../../src/store/sql/graph-store.ts";
import { acquireStoreLock, type StoreLock } from "../../src/store/sql/lock.ts";
import { createSourceOrganizationStore } from "../../src/store/sql/source-organization-store.ts";
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
// Adapter-level crash atomicity: the sqlite row is tests/sql/graph-store.test.ts#C1; this is the DoltLite one (model: C1 there).
describe("SQL adapters: crash atomicity through the GraphStore", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-dolt-crash-"));
	after(() => fs.rmSync(root, { recursive: true, force: true }));
	let n = 0;
	const node = (id: string, statement: string) => ({ id, name: id, statement, aliases: [], createdAt: "t", provenance: [] }) as never;
	const org = (name: string) => ({ version: 1, folders: [{ id: "f1", name, parentId: null, createdAt: "t" }], placements: {} }) as never;
	const positions = { read: () => ({}), write: () => {} };
	type Opened = ReturnType<typeof openGraphStore>;
	/** Open `file` on the real driver (one real lock per folder, held by the caller) behind a faulty wrapper when `fault` is given. */
	function open(file: string, lock: StoreLock, fault?: Fault) {
		const raw = openDoltlite(file, { lock });
		let fd: FaultyDriver | undefined;
		const db = fault ? (fd = faultyDriver(raw, fault)) : raw;
		const opened: Opened = openGraphStore({ db, file: "graph.doltlite", lhVersion: "test", positions, log: () => {} });
		const events: string[] = [];
		const sourceOrg = createSourceOrganizationStore({ core: opened.core, emit: (e) => events.push(e) });
		return { raw, fd: () => fd, opened, sourceOrg, events, close: () => raw.close() };
	}
	const state = (r: ReturnType<typeof open>) => JSON.stringify([r.opened.store.readNodes(), r.opened.store.readChains(), r.opened.store.readCoverage(), r.opened.store.readCheckpoints(), [...r.opened.store.readSources()].sort((a, b) => a.id.localeCompare(b.id)), r.sourceOrg.read(), r.opened.store.revision()]);
	/** What a separate read-only connection sees: the commit messages and whether the working set is dirty. */
	function disk(file: string) {
		const ro = openDoltlite(file, { readOnly: true });
		try { return { log: ro.all<{ message: string }>("SELECT message FROM dolt_log").map((m) => m.message), dirty: ro.all("SELECT * FROM dolt_status").length > 0 }; } finally { ro.close(); }
	}
	const unit = (r: ReturnType<typeof open>) => r.opened.store.transact("unit", () => {
		r.opened.store.appendNode(node("n3", "three"));
		r.opened.store.appendCoverage({ chatId: "c1", fp: "f", tokens: 1, foldedAt: "t" });
		r.opened.store.rewriteLedgers({ nodes: [node("n1", "edited"), node("n2", "two")], chains: [] });
		r.opened.store.upsertSource({ id: "src_2", filePath: "/x/src_2", importedAt: "t" });
		r.opened.store.appendSourceUsage("src_1", { startedAt: 1 } as never);
		r.sourceOrg.write(org("after"));
		return "ok";
	});
	function seeded() {
		const file = path.join(root, `g${n++}`, "graph.doltlite");
		fs.mkdirSync(path.dirname(file));
		const lock = acquireStoreLock(file);
		const s = open(file, lock);
		s.opened.store.appendNode(node("n1", "one")); s.opened.store.appendNode(node("n2", "two"));
		s.opened.store.upsertSource({ id: "src_1", filePath: "/x/src_1", importedAt: "t" }); s.sourceOrg.write(org("before"));
		s.close();
		return { file, lock };
	}

	for (const kind of ["before", "after", "enospc"] as const) {
		it(`FP-DOLT-CRASH ${kind}: a crash at every write step of a transact on the doltlite GraphStore leaves no trace and no commit`, () => {
			const { file, lock } = seeded();
			try {
				const probe = open(file, lock); const baseline = state(probe); probe.close();
				const before = disk(file);
				assert.equal(before.dirty, false, "the seed left a dirty working set");
				let steps = 0;
				for (let nth = 1; nth < 60; nth++) {
					const r = open(file, lock, { kind, nth });
					try {
						try { unit(r); } catch (e) { assert.ok(e instanceof InjectedFault, `step ${nth}: ${String(e)}`); }
						if (!r.fd()?.fired) { assert.ok(nth > 6, "the unit must have several write steps"); break; }
						steps = nth;
						assert.equal(state(r), baseline, `step ${nth} left a trace`);
						assert.deepEqual(r.events, [], "event from a failed transaction");
					} finally { r.close(); }
					assert.deepEqual(disk(file), before, `step ${nth}: a commit or a dirty working set was left on disk`);
				}
				assert.ok(steps >= 6, `only ${steps} fault points exercised`);
				// the loop's last pass ran the same unit with no fault firing: it committed, as exactly one more commit, labelled
				const after = disk(file);
				assert.equal(after.log.length, before.log.length + 1);
				assert.equal(after.log[0], "unit");
				assert.equal(after.dirty, false);
			} finally { lock.release(); }
		});
	}

	it("FP-DOLT-CRASH commit: a failure on COMMIT leaves no trace and no commit", () => {
		const { file, lock } = seeded();
		try {
			const probe = open(file, lock); const baseline = state(probe); probe.close();
			const before = disk(file);
			const r = open(file, lock, { kind: "commit" });
			try {
				assert.throws(() => unit(r), InjectedFault);
				assert.ok(r.fd()?.fired);
				assert.equal(state(r), baseline);
			} finally { r.close(); }
			assert.deepEqual(disk(file), before);
		} finally { lock.release(); }
	});
});
void Cmd;
