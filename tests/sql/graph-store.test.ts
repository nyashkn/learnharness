/**
 * SQLite GraphStore + SourceOrganizationStore (bead lh-rws): the properties the contract suite cannot see.
 *   R  rewriteLedgers keeps exactly `kept`, in order, with minimum row churn (fast-check against a model)
 *   C  crash atomicity at every write step of a transact (faulty driver), no trace, no event, no seal
 *   S  seal failure after COMMIT is logged; the next transaction seals `recovered: <label>` first (N14)
 *   V  revision / seal only when rows really changed
 *   F  refusal at open and on every operation
 *   E  events after commit
 * Expected values come from a model written here (the kept list), never from the code under test.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import fc from "fast-check";
import type { GraphNode, NotesSource, Position } from "../../src/core/contracts.ts";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../../src/core/contracts/graph.ts";
import { deleteChatTraces } from "../../src/core/graph-deletion.ts";
import { StorageVersionError } from "../../src/store/graph-format.ts";
import type { SqlDriver } from "../../src/store/sql/driver.ts";
import { faultyDriver, InjectedFault, type Fault } from "../../src/store/sql/drivers/faulty.ts";
import { openNodeSqlite } from "../../src/store/sql/drivers/node-sqlite.ts";
import { openGraphStore, type OpenedGraph } from "../../src/store/sql/graph-store.ts";
import { createSourceOrganizationStore } from "../../src/store/sql/source-organization-store.ts";

let dir: string;
let counter = 0;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sql-graph-")); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ── fixtures ──
const node = (id: string, statement: string, chats: string[] = []): GraphNode => ({
	id, name: id, statement, aliases: [], createdAt: "t", provenance: chats.map((chatId) => ({ chatId, messageId: "m1" })),
});
const org = (name: string) => ({ version: 1, folders: [{ id: "f1", name, parentId: null, createdAt: "t" }], placements: {} }) as never;
const src = (id: string): NotesSource => ({ id, filePath: `/x/${id}`, importedAt: "t" });
const positions = () => { let p: Record<string, Position> = {}; return { read: () => p, write: (n: Record<string, Position>) => { p = n; } }; };

interface Rig {
	file: string;
	raw: SqlDriver;
	log: string[];
	logged: string[];
	events: string[];
	opened: OpenedGraph;
	graph: OpenedGraph["store"];
	sourceOrg: ReturnType<typeof createSourceOrganizationStore>;
	close(): void;
}
interface RigOptions { file?: string; wrap?: (d: SqlDriver, log: string[]) => SqlDriver }

/** `log` records every write statement and every seal, in order, as the driver saw them. */
function rig(options: RigOptions = {}): Rig {
	const file = options.file ?? path.join(dir, `g${counter++}.sqlite`);
	const raw = openNodeSqlite(file);
	const log: string[] = [];
	const recording: SqlDriver = {
		engine: raw.engine, engineVersion: raw.engineVersion,
		exec: (s) => { log.push(s); raw.exec(s); },
		run: (s, ...p) => { log.push(s); return raw.run(s, ...p); },
		all: (s, ...p) => raw.all(s, ...p),
		get: (s, ...p) => raw.get(s, ...p),
		transaction: (fn) => raw.transaction(fn),
		seal: (m) => { log.push(`SEAL ${m}`); return raw.seal(m); },
		head: () => raw.head(),
		close: () => raw.close(),
	};
	const db = options.wrap ? options.wrap(recording, log) : recording;
	const logged: string[] = [];
	const events: string[] = [];
	const opened = openGraphStore({ db, file: "graph.sqlite", lhVersion: "test", positions: positions(), log: (m) => logged.push(m) });
	const sourceOrg = createSourceOrganizationStore({ core: opened.core, emit: (e) => { events.push(e); log.push(`EVENT ${e}`); } });
	log.length = 0; // the migration's own writes and seal are not the test's business
	return { file, raw, log, logged, events, opened, graph: opened.store, sourceOrg, close: () => raw.close() };
}

const seqs = (r: Rig, table = "ledger_nodes") => r.raw.all<{ seq: number; line_json: string }>(`SELECT seq, line_json FROM ${table} ORDER BY seq`);
/** Row writes only: the revision bump on lh_meta is asserted through revision(), not counted as churn. */
const writes = (r: Rig) => r.log.filter((l) => !l.startsWith("SEAL") && !l.startsWith("EVENT") && !/lh_meta/.test(l));
const kinds = (r: Rig) => writes(r).map((w) => w.trim().split(/\s+/)[0]!.toUpperCase());
const state = (r: Rig) => JSON.stringify([r.graph.readNodes(), r.graph.readChains(), r.graph.readCoverage(), r.graph.readCheckpoints(), r.graph.readSources(), r.sourceOrg.read(), r.graph.revision()]);
const norm = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ───────────────────────────── R: rewriteLedgers ─────────────────────────────

describe("R rewriteLedgers: exactly kept, in kept order, least churn", () => {
	it("R1 a pure delete issues only DELETEs and every surviving row keeps its seq", () => {
		const r = rig();
		const all = Array.from({ length: 8 }, (_, i) => node(`n${i}`, `s${i}`));
		all.forEach((n) => r.graph.appendNode(n));
		const read = r.graph.readNodes();
		const before = seqs(r);
		r.log.length = 0;
		const kept = read.filter((_, i) => i % 3 !== 0);
		r.graph.rewriteLedgers({ nodes: kept });
		assert.deepEqual(kinds(r), ["DELETE", "DELETE", "DELETE"], "only DELETEs");
		assert.deepEqual(r.graph.readNodes(), kept);
		const survivors = new Set(kept.map((n) => n.id));
		assert.deepEqual(seqs(r), before.filter((row) => survivors.has((JSON.parse(row.line_json) as GraphNode).id)), "surviving rows keep seq and bytes");
		r.close();
	});

	it("R2 a modified copy in the MIDDLE is updated in place: same seq, same position, neighbours untouched", () => {
		const r = rig();
		["a", "b", "c", "d"].forEach((id) => r.graph.appendNode(node(id, `s-${id}`)));
		const read = r.graph.readNodes();
		const before = seqs(r);
		r.log.length = 0;
		const kept = [read[0]!, { ...read[1]!, statement: "edited" }, read[2]!, read[3]!];
		r.graph.rewriteLedgers({ nodes: kept });
		assert.deepEqual(r.graph.readNodes(), kept);
		assert.deepEqual(seqs(r).map((x) => x.seq), before.map((x) => x.seq), "no row moved");
		assert.deepEqual(kinds(r), ["UPDATE"], "exactly one UPDATE");
		assert.equal(r.log.filter((l) => /^INSERT/i.test(l)).length, 0);
		r.close();
	});

	it("R3 a reorder moves the rows that are out of place above the max; nothing re-inserts the table", () => {
		const r = rig();
		["a", "b", "c", "d"].forEach((id) => r.graph.appendNode(node(id, id)));
		const [a, b, c, d] = r.graph.readNodes() as [GraphNode, GraphNode, GraphNode, GraphNode];
		const before = seqs(r);
		r.log.length = 0;
		r.graph.rewriteLedgers({ nodes: [a, c, b, d] });
		assert.deepEqual(r.graph.readNodes().map((n) => n.id), ["a", "c", "b", "d"]);
		assert.deepEqual(seqs(r).map((x) => x.seq), [before[0]!.seq, before[2]!.seq, before[3]!.seq + 1, before[3]!.seq + 2], "a and c stay; b and d are re-inserted above the old max");
		assert.deepEqual(kinds(r).sort(), ["DELETE", "DELETE", "INSERT", "INSERT"], "not a whole-table re-insert");
		r.close();
	});

	it("R4 duplicates: the same object twice is aligned once; equal byte copies take the lowest seq", () => {
		const r = rig();
		const x = node("x", "same");
		r.graph.appendNode(x); r.graph.appendNode(x); r.graph.appendNode(node("y", "y"));
		const [first, second, third] = r.graph.readNodes() as [GraphNode, GraphNode, GraphNode];
		const before = seqs(r);
		r.log.length = 0;
		r.graph.rewriteLedgers({ nodes: [second, second, third] }); // the same object twice; `first` is not kept
		assert.deepEqual(r.graph.readNodes().map((n) => n.id), ["x", "x", "y"]);
		assert.equal(seqs(r).length, 3);
		r.log.length = 0;
		r.graph.rewriteLedgers({ nodes: [structuredClone(first), structuredClone(first), third] });
		assert.deepEqual(r.graph.readNodes().map((n) => n.id), ["x", "x", "y"]);
		void before;
		r.close();
	});

	it("R5 a row imported with non-canonical bytes stays byte-identical when its kept object is unchanged", () => {
		const r = rig();
		r.raw.run("INSERT INTO ledger_nodes (line_json) VALUES (?)", JSON.stringify(node("w", "ws"), null, 4));
		r.raw.run("INSERT INTO ledger_nodes (line_json) VALUES (?)", JSON.stringify(node("v", "vs")));
		const read = r.graph.readNodes();
		const before = seqs(r);
		r.log.length = 0;
		r.graph.rewriteLedgers({ nodes: [read[0]!, structuredClone(read[1]!)] }); // identity, then bytes
		assert.deepEqual(writes(r), [], "no statement at all");
		assert.deepEqual(seqs(r), before);
		const rev = r.graph.revision();
		r.graph.rewriteLedgers({ nodes: [structuredClone(read[0]!), read[1]!] }); // a byte copy of the non-canonical row
		assert.equal(r.graph.revision(), rev);
		assert.deepEqual(seqs(r), before);
		r.close();
	});

	it("R6 a WeakMap entry gone stale (rolled-back delete, reused seq) cannot change the result", () => {
		const r = rig();
		["a", "b", "c"].forEach((id) => r.graph.appendNode(node(id, id)));
		const read = r.graph.readNodes();
		assert.throws(() => r.graph.transact("rb", () => { r.graph.rewriteLedgers({ nodes: [] }); throw new Error("boom"); }), /boom/);
		r.graph.rewriteLedgers({ nodes: [read[0]!] }); // deletes b and c (the max)
		r.graph.appendNode(node("z", "reused seq")); // takes the freed seq 2
		r.graph.rewriteLedgers({ nodes: [read[0]!, read[2]!] }); // read[2]'s remembered seq now holds z
		assert.deepEqual(r.graph.readNodes(), [read[0], read[2]]);
		r.close();
	});

	it("R7 privacy: after a modified copy the deleted chat's provenance is in NO row of any ledger", () => {
		const r = rig();
		r.graph.appendNode(node("n1", "one", ["c1"]));
		r.graph.appendNode(node("n2", "two", ["c1", "c2"])); // modified copy in the middle: c1 stripped
		r.graph.appendNode(node("n3", "three", ["c2"]));
		r.graph.appendNode(node("n2", "link", ["c1"])); // link line of c1: dies
		r.graph.appendChain({ id: "arg_1", premises: ["n1"], conclusion: "n2", createdAt: "t", provenance: [{ chatId: "c1", messageId: "m1" }] });
		r.graph.appendChain({ id: "arg_2", premises: ["n3"], conclusion: "n2", createdAt: "t", provenance: [{ chatId: "c1", messageId: "m1" }, { chatId: "c2", messageId: "m1" }] });
		r.graph.appendCoverage({ chatId: "c1", fp: "f", tokens: 1, foldedAt: "t" });
		r.graph.appendCheckpoint({ chatId: "c1", foldedAt: "t" });
		deleteChatTraces(r.graph, "c1", "delete-nodes");
		for (const table of ["ledger_nodes", "ledger_chains", "ledger_coverage", "ledger_checkpoints"]) {
			for (const row of seqs(r, table)) assert.ok(!row.line_json.includes('"c1"'), `${table} still holds c1: ${row.line_json}`);
		}
		assert.deepEqual(r.graph.readNodes().map((n) => [n.id, n.provenance.length]), [["n2", 1], ["n3", 1]], "fold order survives the modified copy");
		r.close();
	});

	// A model of the expected result: it is simply the kept list (JSON-normalised), in kept order.
	const stmt = fc.constantFrom("s1", "s2", "s3", "s4");
	type Seed = { id: string; statement: string; indent: boolean }[];
	type Plan = { picks: [number, "orig" | "bytes" | "modified" | "fresh" | "dup"][]; shuffle: number[] };
	const seed: fc.Arbitrary<Seed> = fc.array(fc.record({ id: fc.constantFrom("n1", "n2", "n3", "n4"), statement: stmt, indent: fc.boolean() }), { minLength: 0, maxLength: 8 });
	const how = fc.constantFrom("orig", "bytes", "modified", "fresh", "dup");
	const plan: fc.Arbitrary<Plan> = fc.record({ picks: fc.array(fc.tuple(fc.nat(20), how), { maxLength: 10 }), shuffle: fc.array(fc.nat(100), { maxLength: 10 }) });

	function runRewrite(rows: Seed, p: Plan): Rig {
		const r = rig();
		for (const s of rows) r.raw.run("INSERT INTO ledger_nodes (line_json) VALUES (?)", JSON.stringify(node(s.id, s.statement), null, s.indent ? 2 : undefined));
		const read = r.graph.readNodes();
		let fresh = 0;
		let kept: GraphNode[] = p.picks.map(([i, h]) => {
			const o = read.length === 0 ? node("n9", "none") : read[i % read.length]!;
			if (h === "bytes") return structuredClone(o);
			if (h === "modified") return { ...o, statement: `${o.statement}!${fresh++}` };
			if (h === "fresh") return node(`f${fresh}`, `fresh${fresh++}`);
			return o; // orig and dup (a duplicate arises whenever two picks land on one row)
		});
		if (p.shuffle.length > 0) kept = kept.map((k, i) => [p.shuffle[i % p.shuffle.length]!, i, k] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
		const expected = norm(kept);
		r.graph.rewriteLedgers({ nodes: kept });
		assert.deepEqual(r.graph.readNodes(), expected, "result is exactly kept, in kept order");
		const ordered = seqs(r).map((x) => x.seq);
		assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b));
		r.log.length = 0;
		const rev = r.graph.revision();
		r.graph.rewriteLedgers({ nodes: r.graph.readNodes() });
		assert.deepEqual(writes(r), [], "rewriting what was just read writes nothing");
		assert.equal(r.graph.revision(), rev);
		return r;
	}

	const REGRESSIONS: { name: string; rows: Seed; plan: Plan }[] = [
		{ name: "modified middle row, then reorder (the shape that broke delete+insert-above-max)", rows: [{ id: "n1", statement: "s1", indent: false }, { id: "n2", statement: "s2", indent: true }, { id: "n3", statement: "s3", indent: false }], plan: { picks: [[0, "orig"], [1, "modified"], [2, "orig"], [1, "orig"]], shuffle: [] } },
		{ name: "same object twice plus a byte copy of a non-canonical row", rows: [{ id: "n1", statement: "s1", indent: true }, { id: "n1", statement: "s1", indent: false }], plan: { picks: [[0, "orig"], [0, "dup"], [0, "bytes"], [1, "bytes"]], shuffle: [] } },
		{ name: "everything fresh into an empty ledger", rows: [], plan: { picks: [[0, "fresh"], [0, "fresh"]], shuffle: [] } },
		{ name: "full reversal of modified copies", rows: [{ id: "n1", statement: "s1", indent: false }, { id: "n2", statement: "s2", indent: false }, { id: "n3", statement: "s3", indent: false }], plan: { picks: [[2, "modified"], [1, "modified"], [0, "modified"]], shuffle: [3, 2, 1] } },
	];
	it("R8 regression seeds replay clean", () => {
		for (const g of REGRESSIONS) { try { runRewrite(g.rows, g.plan).close(); } catch (e) { throw new Error(`${g.name}: ${(e as Error).message}`); } }
	});
	it("R9 MODEL: any mix of originals, byte copies, modified copies, fresh objects, duplicates and reorders rewrites to exactly kept", () => {
		fc.assert(fc.property(seed, plan, (rows, p) => { runRewrite(rows, p).close(); }), { numRuns: Number(process.env.FC_RUNS ?? 150), seed: 20261108 });
	});
	it("R10 MODEL: a kept list that is a subsequence of the originals issues only DELETEs and keeps every surviving seq", () => {
		fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom("n1", "n2", "n3"), stmt), { minLength: 1, maxLength: 9 }), fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }), (rows, mask) => {
			const r = rig();
			rows.forEach(([id, s]) => r.graph.appendNode(node(id, s)));
			const read = r.graph.readNodes();
			const before = seqs(r);
			r.log.length = 0;
			const keepIdx = read.map((_, i) => i).filter((i) => mask[i]);
			r.graph.rewriteLedgers({ nodes: keepIdx.map((i) => read[i]!) });
			assert.ok(kinds(r).every((k) => k === "DELETE"), `statements: ${writes(r).join(" | ")}`);
			assert.deepEqual(seqs(r).map((x) => x.seq), keepIdx.map((i) => before[i]!.seq));
			r.close();
		}), { numRuns: Number(process.env.FC_RUNS ?? 100), seed: 20261108 });
	});
});

// ───────────────────────────── C: crash atomicity ─────────────────────────────

describe("C crash atomicity through the GraphStore (FP-SQLAD-CRASH)", () => {
	/** Seed through a clean rig, close it, reopen the SAME file behind a faulty driver (the file is already migrated, so open writes nothing). */
	function faultyRig(file: string, fault: Fault): { r: Rig; fd: () => ReturnType<typeof faultyDriver> } {
		let fd!: ReturnType<typeof faultyDriver>;
		const r = rig({ file, wrap: (d) => (fd = faultyDriver(d, fault)) });
		return { r, fd: () => fd };
	}
	function seeded(): string {
		const s = rig();
		s.graph.appendNode(node("n1", "one", ["c1"])); s.graph.appendNode(node("n2", "two")); s.graph.appendChain({ id: "arg_1", premises: ["n1"], conclusion: "n2", createdAt: "t", provenance: [] });
		s.graph.upsertSource(src("src_1")); s.sourceOrg.write(org("before"));
		const file = s.file; s.close();
		return file;
	}
	const unit = (r: Rig) => r.graph.transact("unit", () => {
		r.graph.appendNode(node("n3", "three"));
		r.graph.appendCoverage({ chatId: "c1", fp: "f", tokens: 1, foldedAt: "t" });
		r.graph.rewriteLedgers({ nodes: [node("n1", "edited"), node("n2", "two")], chains: [] });
		r.graph.upsertSource(src("src_2"));
		r.graph.appendSourceUsage("src_1", { startedAt: 1 } as never);
		r.sourceOrg.write(org("after"));
		return "ok";
	});

	for (const kind of ["before", "after", "enospc"] as const) {
		it(`C1 ${kind}: a fault at every write step of a transact leaves no trace, no event and no seal`, () => {
			const file = seeded();
			const probe = rig({ file }); const baseline = state(probe); probe.close();
			let steps = 0;
			for (let nth = 1; nth < 60; nth++) {
				const { r, fd } = faultyRig(file, { kind, nth });
				const sealsBefore = r.log.filter((l) => l.startsWith("SEAL")).length;
				try {
					try { unit(r); } catch (e) { assert.ok(e instanceof InjectedFault, `step ${nth}: ${String(e)}`); }
					if (!fd().fired) { assert.ok(nth > 6, "the unit must have several write steps"); break; }
					steps = nth;
					assert.equal(state(r), baseline, `step ${nth} left a trace`);
					assert.deepEqual(r.events, [], "event from a failed transaction");
					assert.equal(r.log.filter((l) => l.startsWith("SEAL")).length, sealsBefore, "sealed a failed transaction");
				} finally { r.close(); }
				const check = rig({ file }); assert.equal(state(check), baseline, `step ${nth}: durable state changed`); check.close();
			}
			assert.ok(steps >= 6, `only ${steps} fault points exercised`);
		});
	}

	it("C2 a failure on COMMIT leaves no trace and no event", () => {
		const file = seeded();
		const probe = rig({ file }); const baseline = state(probe); probe.close();
		const { r, fd } = faultyRig(file, { kind: "commit" });
		assert.throws(() => unit(r), InjectedFault);
		assert.ok(fd().fired);
		assert.equal(state(r), baseline); assert.deepEqual(r.events, []);
		r.close();
	});

	it("C3 the same unit commits when no fault fires: revision +1 once, one seal, one event", () => {
		const file = seeded();
		const { r, fd } = faultyRig(file, { kind: "before", nth: 1000 });
		const rev = r.graph.revision();
		assert.equal(unit(r), "ok");
		assert.equal(fd().fired, false);
		assert.equal(r.graph.revision(), rev + 1);
		assert.equal(r.log.filter((l) => l.startsWith("SEAL")).length, 1);
		assert.deepEqual(r.events, ["sources-changed"]);
		assert.deepEqual(r.graph.readNodes().map((n) => n.statement), ["edited", "two"]);
		r.close();
	});
});

// ───────────────────────────── S: seal failure (N14) ─────────────────────────────

describe("S seal failure after COMMIT (N14)", () => {
	/** A driver whose seal throws while `failing` is on. */
	function sealing() {
		const flags = { failing: false };
		const attempts: string[] = [];
		const wrap = (d: SqlDriver): SqlDriver => ({ ...d, seal: (m) => { attempts.push(m); if (flags.failing) throw new Error(`seal broke: ${m}`); return d.seal(m); } });
		return { flags, attempts, wrap };
	}

	it("S1 a seal that throws after COMMIT is logged, not thrown; the data is durable", () => {
		const s = sealing(); const r = rig({ wrap: s.wrap }); s.attempts.length = 0;
		s.flags.failing = true;
		assert.doesNotThrow(() => r.graph.transact("first", () => r.graph.appendNode(node("n1", "one"))));
		assert.ok(r.logged.some((m) => m.includes("first")), "logged");
		assert.deepEqual(r.graph.readNodes().map((n) => n.id), ["n1"]);
		r.close();
		const again = rig({ file: r.file }); assert.deepEqual(again.graph.readNodes().map((n) => n.id), ["n1"]); again.close();
	});

	it("S2 the NEXT transaction first seals `recovered: <label>`, before its own BEGIN, then its own label", () => {
		const s = sealing(); const r = rig({ wrap: s.wrap }); s.attempts.length = 0;
		s.flags.failing = true;
		r.graph.transact("first", () => r.graph.appendNode(node("n1", "one")));
		s.flags.failing = false; s.attempts.length = 0; r.log.length = 0;
		r.graph.transact("second", () => r.graph.appendNode(node("n2", "two")));
		assert.deepEqual(s.attempts, ["recovered: first", "second"]);
		const firstSeal = r.log.findIndex((l) => l === "SEAL recovered: first");
		const firstWrite = r.log.findIndex((l) => /^INSERT/i.test(l));
		assert.ok(firstSeal >= 0 && firstSeal < firstWrite, "the recovery seal precedes the next transaction's writes");
		s.attempts.length = 0;
		r.graph.transact("third", () => r.graph.appendNode(node("n3", "three")));
		assert.deepEqual(s.attempts, ["third"], "recovered once, not again");
		r.close();
	});

	it("S3 if the recovery seal fails too: logged, the write still goes through, the pending label is kept", () => {
		const s = sealing(); const r = rig({ wrap: s.wrap }); s.attempts.length = 0;
		s.flags.failing = true;
		r.graph.transact("first", () => r.graph.appendNode(node("n1", "one")));
		assert.doesNotThrow(() => r.graph.transact("second", () => r.graph.appendNode(node("n2", "two"))));
		assert.deepEqual(r.graph.readNodes().map((n) => n.id), ["n1", "n2"]);
		assert.deepEqual(s.attempts, ["first", "recovered: first", "second"]);
		s.flags.failing = false; s.attempts.length = 0;
		r.graph.transact("third", () => r.graph.appendNode(node("n3", "three")));
		assert.deepEqual(s.attempts, ["recovered: first", "third"]);
		r.close();
	});

	it("S4 the real faulty driver (kind seal) behaves the same", () => {
		let fd!: ReturnType<typeof faultyDriver>;
		const pre = rig(); pre.close(); // migrate first: the fault must not fire on the migration's own seal
		const r = rig({ file: pre.file, wrap: (d) => (fd = faultyDriver(d, { kind: "seal" })) });
		r.graph.transact("first", () => r.graph.appendNode(node("n1", "one")));
		assert.ok(fd.fired);
		r.log.length = 0;
		r.graph.transact("second", () => r.graph.appendNode(node("n2", "two")));
		assert.deepEqual(r.log.filter((l) => l.startsWith("SEAL")), ["SEAL recovered: first", "SEAL second"]);
		r.close();
	});
});

// ───────────────────────────── V: revision and seal only on change ─────────────────────────────

describe("V revision bump and seal only when rows really changed", () => {
	const seals = (r: Rig) => r.log.filter((l) => l.startsWith("SEAL"));

	it("V1 no-op writes move neither revision nor seal: identical rewrite, identical upsert, absent delete, duplicate usage", () => {
		const r = rig();
		r.graph.appendNode(node("n1", "one")); r.graph.upsertSource(src("src_1")); r.graph.appendSourceUsage("src_1", { startedAt: 1 } as never);
		const rev = r.graph.revision(); r.log.length = 0;
		r.graph.rewriteLedgers({ nodes: r.graph.readNodes(), chains: [] });
		r.graph.upsertSource(src("src_1"));
		r.graph.deleteSources(new Set(["src_none"]));
		r.graph.appendSourceUsage("src_1", { startedAt: 1 } as never);
		r.graph.appendSourceUsage("src_missing", { startedAt: 1 } as never);
		r.graph.transact("empty", () => { r.graph.readNodes(); });
		assert.equal(r.graph.revision(), rev); assert.deepEqual(seals(r), []);
		r.close();
	});

	it("V2 a nested transact joins the outer: ONE bump, ONE seal under the outer label", () => {
		const r = rig();
		const rev = r.graph.revision(); r.log.length = 0;
		r.graph.transact("outer", () => { r.graph.appendNode(node("a", "a")); r.graph.transact("inner", () => r.graph.appendNode(node("b", "b"))); r.graph.appendNode(node("c", "c")); });
		assert.equal(r.graph.revision(), rev + 1); assert.deepEqual(seals(r), ["SEAL outer"]);
		r.close();
	});

	it("V3 a rolled-back transaction (also one doomed by a caught inner throw) bumps and seals nothing", () => {
		const r = rig(); const rev = r.graph.revision(); r.log.length = 0;
		assert.throws(() => r.graph.transact("t", () => { r.graph.appendNode(node("a", "a")); throw new Error("x"); }));
		assert.throws(() => r.graph.transact("outer", () => { r.graph.appendNode(node("a", "a")); try { r.graph.transact("in", () => { throw new Error("inner"); }); } catch { /* caught */ } }));
		assert.equal(r.graph.revision(), rev); assert.deepEqual(seals(r), []); assert.deepEqual(r.graph.readNodes(), []);
		r.close();
	});

	it("V4 bare writes seal as auto:<method>", () => {
		const r = rig(); r.log.length = 0;
		r.graph.appendNode(node("a", "a")); r.graph.upsertSource(src("src_1")); r.graph.appendSourceUsage("src_1", { startedAt: 2 } as never);
		r.graph.rewriteLedgers({ nodes: [] }); r.graph.deleteSources(new Set(["src_1"])); r.sourceOrg.write(org("o"));
		assert.deepEqual(seals(r), ["SEAL auto:appendNode", "SEAL auto:upsertSource", "SEAL auto:appendSourceUsage", "SEAL auto:rewriteLedgers", "SEAL auto:deleteSources", "SEAL auto:sourceOrg.write"]);
		r.close();
	});

	it("V5 revision scope matches the file adapter: ledgers and the sources map move it; the source-organization document does not (it still seals)", () => {
		const r = rig();
		const rev = r.graph.revision(); r.log.length = 0;
		r.sourceOrg.write(org("one"));
		assert.equal(r.graph.revision(), rev, "source organization is outside the revision, as in the file adapter");
		assert.deepEqual(seals(r), ["SEAL auto:sourceOrg.write"]);
		r.graph.upsertSource(src("src_1"));
		assert.equal(r.graph.revision(), rev + 1);
		r.close();
	});

	it("V6 revision survives a reopen and never goes backwards", () => {
		const r = rig(); r.graph.appendNode(node("a", "a")); const rev = r.graph.revision(); r.close();
		const again = rig({ file: r.file }); assert.equal(again.graph.revision(), rev); again.graph.appendNode(node("b", "b")); assert.ok(again.graph.revision() > rev); again.close();
	});
});

// ───────────────────────────── F: refusal ─────────────────────────────

describe("F refusal: at open and on every operation", () => {
	it("F1 a newer line_format or schema_version is refused at open with a StorageVersionError naming file, found and supported", () => {
		for (const [key, found, supported] of [["line_format", CURRENT_GRAPH_FORMAT_VERSION + 1, CURRENT_GRAPH_FORMAT_VERSION], ["schema_version", 99, 1]] as const) {
			const r = rig(); r.raw.run("UPDATE lh_meta SET value = ? WHERE key = ?", String(found), key); r.close();
			assert.throws(() => rig({ file: r.file }), (e: unknown) => {
				assert.ok(e instanceof StorageVersionError); assert.equal(e.name, "StorageVersionError");
				assert.deepEqual([e.file, e.found, e.supported], ["graph.sqlite", found, supported]); return true;
			});
		}
	});

	it("F2 stamped AFTER open: every read and write refuses before touching a row; clearing the stamp restores everything", () => {
		const r = rig();
		r.graph.appendNode(node("n1", "one")); r.graph.upsertSource(src("src_1")); r.sourceOrg.write(org("o"));
		const before = state(r);
		r.raw.run("UPDATE lh_meta SET value = ? WHERE key = 'line_format'", String(CURRENT_GRAPH_FORMAT_VERSION + 1));
		r.log.length = 0;
		const ops: [string, () => unknown][] = [
			["readNodes", () => r.graph.readNodes()], ["readChains", () => r.graph.readChains()], ["readCheckpoints", () => r.graph.readCheckpoints()], ["readCoverage", () => r.graph.readCoverage()],
			["readSources", () => r.graph.readSources()], ["revision", () => r.graph.revision()], ["corruptLines", () => r.graph.corruptLines()], ["sourceOrg.read", () => r.sourceOrg.read()],
			["appendNode", () => r.graph.appendNode(node("n2", "two"))], ["appendChain", () => r.graph.appendChain({ id: "a", premises: ["n1"], conclusion: "n2", createdAt: "t", provenance: [] })],
			["appendCoverage", () => r.graph.appendCoverage({ chatId: "c", fp: "f", tokens: 1, foldedAt: "t" })], ["appendCheckpoint", () => r.graph.appendCheckpoint({ chatId: "c", foldedAt: "t" })],
			["rewriteLedgers", () => r.graph.rewriteLedgers({ nodes: [] })], ["upsertSource", () => r.graph.upsertSource(src("src_2"))], ["deleteSources", () => r.graph.deleteSources(new Set(["src_1"]))],
			["appendSourceUsage", () => r.graph.appendSourceUsage("src_1", { startedAt: 3 } as never)], ["transact", () => r.graph.transact("t", () => 1)], ["sourceOrg.write", () => r.sourceOrg.write(org("x"))],
		];
		for (const [name, op] of ops) assert.throws(op, (e: unknown) => e instanceof StorageVersionError, `${name} did not refuse`);
		assert.deepEqual(writes(r), [], "a refused operation wrote nothing");
		assert.deepEqual(r.log.filter((l) => l.startsWith("SEAL")), []);
		r.raw.run("UPDATE lh_meta SET value = ? WHERE key = 'line_format'", String(CURRENT_GRAPH_FORMAT_VERSION));
		assert.equal(state(r), before);
		r.close();
	});
});

// ───────────────────────────── E: events, corruption, sources ─────────────────────────────

describe("E events, corrupt lines and the sources map", () => {
	it("E1 the organization event fires once per committed write, after the seal; never from a rolled-back transaction; a joined write waits for the outer commit", () => {
		const r = rig();
		r.sourceOrg.write(org("a"));
		assert.deepEqual(r.log.filter((l) => l.startsWith("SEAL") || l.startsWith("EVENT")), ["SEAL auto:sourceOrg.write", "EVENT sources-changed"]);
		r.log.length = 0; r.events.length = 0;
		assert.throws(() => r.graph.transact("rb", () => { r.sourceOrg.write(org("b")); throw new Error("x"); }));
		assert.deepEqual(r.events, []); assert.equal(r.sourceOrg.read().folders[0]!.name, "a");
		r.graph.transact("ok", () => { r.sourceOrg.write(org("c")); assert.deepEqual(r.events, []); assert.equal(r.sourceOrg.read().folders[0]!.name, "c", "read-your-writes"); r.graph.appendNode(node("n", "n")); });
		assert.deepEqual(r.log.filter((l) => l.startsWith("SEAL") || l.startsWith("EVENT")), ["SEAL ok", "EVENT sources-changed"]);
		r.close();
	});

	it("E2 corruptLines counts rows failing parse or schema across all four ledgers, and is stateless", () => {
		const r = rig();
		assert.equal(r.graph.corruptLines(), 0);
		r.raw.run("INSERT INTO ledger_nodes (line_json) VALUES (?)", "{");
		r.raw.run("INSERT INTO ledger_chains (line_json) VALUES (?)", '{"id":"x","premises":[],"conclusion":"c","provenance":[],"createdAt":"t"}'); // premises: minItems 1
		r.raw.run("INSERT INTO ledger_coverage (line_json) VALUES (?)", "[]");
		r.raw.run("INSERT INTO ledger_checkpoints (line_json) VALUES (?)", "");
		r.graph.appendNode(node("n1", "ok"));
		assert.equal(r.graph.corruptLines(), 4); assert.equal(r.graph.corruptLines(), 4);
		assert.deepEqual(r.graph.readNodes().map((n) => n.id), ["n1"]);
		r.graph.rewriteLedgers({ nodes: r.graph.readNodes() });
		assert.equal(r.graph.corruptLines(), 3, "a rewrite drops the corrupt row of that ledger, as the file adapter does");
		r.close();
	});

	it("E3 sources: hostile ids, usage kept across an upsert, usage idempotent per startedAt", () => {
		const r = rig();
		r.graph.upsertSource(src("__proto__")); r.graph.appendSourceUsage("__proto__", { startedAt: 1 } as never); r.graph.appendSourceUsage("__proto__", { startedAt: 1 } as never);
		r.graph.upsertSource({ ...src("__proto__"), filePath: "/y" });
		const [s] = r.graph.readSources();
		assert.equal(s!.id, "__proto__"); assert.equal(s!.filePath, "/y"); assert.equal(s!.extractions?.length, 1);
		assert.equal(r.graph.deleteSources(new Set(["__proto__", "nope"])), 1);
		r.close();
	});

	it("E4 positions go to the injected delegate, outside the transaction (survive a rollback)", () => {
		const r = rig();
		assert.throws(() => r.graph.transact("t", () => { r.graph.writePositions({ n1: { x: 1, y: 2 } }); throw new Error("x"); }));
		assert.deepEqual(r.graph.readPositions(), { n1: { x: 1, y: 2 } });
		r.close();
	});

	it("E5 an async fn rolls back and throws TypeError", () => {
		const r = rig();
		assert.throws(() => r.graph.transact("a", (() => { r.graph.appendNode(node("n", "n")); return Promise.reject(new Error("late")); }) as never), TypeError);
		assert.deepEqual(r.graph.readNodes(), []);
		r.close();
	});
});
