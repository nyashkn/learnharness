/**
 * projections.sqlite builder (bead lh-iz9). Failpoints, each with its own test group:
 *   M  model-based: every read matches an independent reference fold of the fake graph
 *   T  rebuild triggers (storeId, revision, open) and the no-rebuild case
 *   X  same-txn: a fault at every write step leaves old rows AND old cursor intact
 *   H  projection_hash inputs, and an on-disk hash/shape mismatch rebuilding at open
 *   C  closure CTE against a BFS reference, on graphs with cycles
 *   S  FTS5 search: ids only, never throws, ranking, empty input
 *   P  two PROCESSES rebuilding one file at different revisions
 * Expected values come from references written here (refRows, bfs, tokens), never from the code under test.
 * No counterexample has shrunk so far, so there are no regression seeds yet.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import fc from "fast-check";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import type { SqlDriver } from "../src/store/sql/driver.ts";
import { faultyDriver, type Fault, type FaultyDriver } from "../src/store/sql/drivers/faulty.ts";
import { openNodeSqlite } from "../src/store/sql/drivers/node-sqlite.ts";
import { CURRENT_PROJECTION_HASH, LOGIC_VERSION, openProjectionStore, projectionHash } from "../src/store/projections/projection-store.ts";
import { PROJECTION_DDL } from "../src/store/projections/schema.ts";

// ── fake graph (in-memory lines + a revision counter the test controls) ──
class FakeGraph {
	nodes: GraphNode[] = [];
	chains: GraphChain[] = [];
	rev = 0;
	readCalls = 0;
	readNodes() { this.readCalls++; return structuredClone(this.nodes); }
	readChains() { return structuredClone(this.chains); }
	revision() { return this.rev; }
}
let chainSeq = 0;
const nodeLine = (id: string, name: string, statement: string, aliases: string[] = [], chat = "c1"): GraphNode =>
	({ id, name, statement, aliases, createdAt: "t0", provenance: [{ chatId: chat, messageId: "m1" }] });
const chainLine = (premises: string[], conclusion: string): GraphChain =>
	({ id: `arg_${chainSeq++}`, premises, conclusion, provenance: [{ chatId: "c1", messageId: "m1" }], createdAt: "t1" });

// ── independent reference fold: lines -> canonical rows ──
interface Rows { node: string[][]; alias: string[][]; prov: string[][]; chain: string[][]; premise: string[][]; fts: string[][] }
const canon = (rows: string[][]) => rows.map((r) => JSON.stringify(r)).sort().map((j) => JSON.parse(j) as string[]);
function refRows(nodeLines: GraphNode[], chainLines: GraphChain[]): Rows {
	const nodes = new Map<string, { first: GraphNode; aliases: string[]; prov: Set<string> }>();
	for (const l of nodeLines) {
		const e = nodes.get(l.id);
		if (!e) { nodes.set(l.id, { first: l, aliases: [...new Set(l.aliases)], prov: new Set(l.provenance.map((p) => `${p.chatId}\u0000${p.messageId}`)) }); continue; }
		for (const s of [l.statement, ...l.aliases]) if (s !== "" && !e.aliases.includes(s)) e.aliases.push(s);
		for (const p of l.provenance) e.prov.add(`${p.chatId}\u0000${p.messageId}`);
	}
	const chains = new Map<string, GraphChain>();
	for (const l of chainLines) { const k = `${[...l.premises].sort().join("+")}>${l.conclusion}`; if (!chains.has(k)) chains.set(k, l); }
	const r: Rows = { node: [], alias: [], prov: [], chain: [], premise: [], fts: [] };
	for (const [id, e] of nodes) {
		r.node.push([id, e.first.name, e.first.statement, e.first.createdAt]);
		for (const a of e.aliases) r.alias.push([id, a]);
		for (const p of e.prov) r.prov.push([id, ...p.split("\u0000")]);
		r.fts.push([id, e.first.name, e.first.statement, e.aliases.join("\n")]);
	}
	for (const c of chains.values()) {
		r.chain.push([c.id, c.conclusion, c.createdAt]);
		for (const p of new Set(c.premises)) r.premise.push([c.id, p]);
	}
	return { node: canon(r.node), alias: canon(r.alias), prov: canon(r.prov), chain: canon(r.chain), premise: canon(r.premise), fts: canon(r.fts) };
}
function dump(file: string): { rows: Rows; cursor: string[] } {
	const d = openNodeSqlite(file);
	try {
		const q = (sql: string) => canon(d.all<Record<string, string>>(sql).map((o) => Object.values(o)));
		const c = d.get<{ store_id: string; source_revision: string }>("SELECT store_id, source_revision FROM proj_cursor WHERE id = 1");
		return {
			rows: {
				node: q("SELECT id, name, statement, created_at FROM node"), alias: q("SELECT node_id, alias FROM node_alias"),
				prov: q("SELECT node_id, chat_id, message_id FROM node_provenance"), chain: q("SELECT id, conclusion_id, created_at FROM chain"),
				premise: q("SELECT chain_id, premise_id FROM chain_premise"), fts: q("SELECT node_id, name, statement, aliases FROM node_fts"),
			},
			cursor: c ? [c.store_id, c.source_revision] : [],
		};
	} finally { d.close(); }
}
const raw = (file: string, sql: string) => { const d = openNodeSqlite(file); try { d.exec(sql); } finally { d.close(); } };
const bfs = (chains: GraphChain[], target: string): string[] => {
	const seen = new Set([target]); const queue = [target];
	while (queue.length) { const cur = queue.shift()!; for (const c of chains) if (c.conclusion === cur) for (const p of c.premises) if (!seen.has(p)) { seen.add(p); queue.push(p); } }
	return [...seen].sort();
};
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

let dir: string;
let counter = 0;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-proj-")); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const newFile = () => path.join(dir, `p${counter++}.sqlite`);

// ── M: model-based ──
const POOL = ["n1", "n2", "n3", "n4", "n5"];
const VOCAB = ["alpha", "Beta", "gamma", "delta", "eps1", "zed"];
const JUNK = ['"', "AND", "NEAR(", "*", "-", ":", "OR", "(", "^", "alpha*", '"alpha', "NOT"];
type Model = { nodes: GraphNode[]; chains: GraphChain[]; rev: number; storeId: string };
interface Real { g: FakeGraph; file: string; store: ReturnType<typeof openProjectionStore>; storeId: string }
const open = (r: Real, storeId: string) => { r.store.close(); r.store = openProjectionStore({ file: r.file, storeId, graph: r.g }); r.storeId = storeId; };
const expectSynced = (m: Model, r: Real) => {
	const got = dump(r.file);
	assert.deepEqual(got.rows, refRows(m.nodes, m.chains));
	assert.deepEqual(got.cursor, [m.storeId, String(m.rev)]);
};
type Cmd = fc.Command<Model, Real>;
const appendNode = (id: string, a: string, b: string, chat: string): Cmd => ({
	check: () => true, toString: () => `appendNode(${id},${a},${b},${chat})`,
	run(m, r) { const line = nodeLine(id, `name-${a}`, `${a} ${b}`, [b], chat); m.nodes.push(line); m.rev++; r.g.nodes.push(structuredClone(line)); r.g.rev++; },
});
const appendChain = (premises: string[], conclusion: string): Cmd => ({
	check: () => true, toString: () => `appendChain([${premises}],${conclusion})`,
	run(m, r) { const line = chainLine(premises, conclusion); m.chains.push(line); m.rev++; r.g.chains.push(structuredClone(line)); r.g.rev++; },
});
const bump: Cmd = { check: () => true, toString: () => "bumpRevision", run(m, r) { m.rev++; r.g.rev++; } };
const changeStore = (id: string): Cmd => ({ check: () => true, toString: () => `changeStoreId(${id})`, run(m, r) { m.storeId = id; open(r, id); } });
const reopen: Cmd = { check: () => true, toString: () => "reopen", run(m, r) { open(r, m.storeId); } };
const closure = (t: string): Cmd => ({
	check: () => true, toString: () => `deriveClosure(${t})`,
	run(m, r) { assert.deepEqual(r.store.deriveClosure(t), bfs(m.chains, t)); expectSynced(m, r); },
});
const search = (q: string, limit: number): Cmd => ({
	check: () => true, toString: () => `search(${JSON.stringify(q)},${limit})`,
	run(m, r) {
		const qt = new Set(tokens(q));
		const ref = refRows(m.nodes, m.chains).fts;
		const expected = ref.filter((f) => tokens(f.slice(1).join(" ")).some((t) => qt.has(t))).map((f) => f[0]!);
		const got = r.store.search(q, limit);
		assert.equal(got.length, Math.min(limit, expected.length));
		assert.equal(new Set(got).size, got.length);
		for (const id of got) assert.ok(expected.includes(id), `${id} does not contain a query word`);
		if (qt.size > 0) expectSynced(m, r);
	},
});
const cmds = fc.commands([
	fc.record({ id: fc.constantFrom(...POOL), a: fc.constantFrom(...VOCAB), b: fc.constantFrom(...VOCAB), chat: fc.constantFrom("c1", "c2") }).map((x) => appendNode(x.id, x.a, x.b, x.chat)),
	fc.record({ p: fc.array(fc.constantFrom(...POOL), { minLength: 1, maxLength: 3 }), c: fc.constantFrom(...POOL) }).map((x) => appendChain(x.p, x.c)),
	fc.constant(bump), fc.constantFrom("s1", "s2", "s3").map(changeStore), fc.constant(reopen),
	fc.constantFrom(...POOL, "unknown").map(closure),
	fc.record({ words: fc.array(fc.constantFrom(...VOCAB, ...JUNK), { maxLength: 4 }), lim: fc.integer({ min: 1, max: 6 }) }).map((x) => search(x.words.join(" "), x.lim)),
], { maxCommands: 14 });

describe("M model-based", () => {
	it("every read matches the reference fold of the current fake graph", () => {
		fc.assert(fc.property(cmds, (c) => {
			const g = new FakeGraph(); const file = newFile();
			const real: Real = { g, file, store: openProjectionStore({ file, storeId: "s1", graph: g }), storeId: "s1" };
			try { fc.modelRun(() => ({ model: { nodes: [], chains: [], rev: 0, storeId: "s1" }, real }), c); } finally { real.store.close(); }
		}), { numRuns: 60 });
	});
});

// ── T: rebuild triggers ──
describe("T rebuild triggers", () => {
	const setup = (storeId = "s1") => {
		const g = new FakeGraph(); g.nodes.push(nodeLine("a", "A", "alpha thing"), nodeLine("b", "B", "beta thing")); g.chains.push(chainLine(["a"], "b")); g.rev = 1;
		const file = newFile();
		return { g, file, store: openProjectionStore({ file, storeId, graph: g }) };
	};
	const names = (file: string) => dump(file).rows.node.map((r) => r[1]);

	it("a matching cursor does not rebuild: a tampered row survives two reads", () => {
		const { g, file, store } = setup();
		const opened = g.readCalls;
		raw(file, "UPDATE node SET name = 'TAMPERED' WHERE id = 'a'");
		store.deriveClosure("b"); store.search("alpha", 5);
		assert.equal(g.readCalls, opened);
		assert.ok(names(file).includes("TAMPERED"));
		store.close();
	});
	it("a revision mismatch rebuilds in full", () => {
		const { g, file, store } = setup();
		raw(file, "UPDATE node SET name = 'TAMPERED' WHERE id = 'a'");
		g.rev++; store.deriveClosure("b");
		assert.deepEqual(names(file), ["A", "B"]);
		assert.deepEqual(dump(file).cursor, ["s1", "2"]);
		store.close();
	});
	it("a storeId mismatch in the cursor rebuilds in full", () => {
		const { file, store } = setup();
		raw(file, "UPDATE node SET name = 'TAMPERED' WHERE id = 'a'; UPDATE proj_cursor SET store_id = 'other'");
		store.search("alpha", 5);
		assert.deepEqual(names(file), ["A", "B"]);
		assert.deepEqual(dump(file).cursor, ["s1", "1"]);
		store.close();
	});
	it("opening rebuilds even when the cursor matches", () => {
		const { g, file, store } = setup();
		store.close();
		raw(file, "UPDATE node SET name = 'TAMPERED' WHERE id = 'a'");
		const before = g.readCalls;
		openProjectionStore({ file, storeId: "s1", graph: g }).close();
		assert.equal(g.readCalls, before + 1);
		assert.deepEqual(names(file), ["A", "B"]);
	});
	it("opening with another storeId rewrites the cursor", () => {
		const { g, file, store } = setup();
		store.close();
		openProjectionStore({ file, storeId: "s2", graph: g }).close();
		assert.deepEqual(dump(file).cursor, ["s2", "1"]);
	});
	it("a write landing between the revision read and the fold leaves a stale-low cursor, so the next read rebuilds", () => {
		const { g, file, store } = setup();
		const readNodes = g.readNodes.bind(g);
		let once = true;
		g.readNodes = () => { const r = readNodes(); if (once) { once = false; g.nodes.push(nodeLine("c", "C", "gamma")); g.rev++; } return r; };
		g.rev++; // revision 2 is read, then a write makes it 3 while the fold runs
		store.deriveClosure("b"); // sync sees 1 != 2 -> rebuild: pre-read 2, fold misses c
		assert.deepEqual(dump(file).cursor, ["s1", "2"]);
		assert.deepEqual(names(file), ["A", "B"]);
		store.deriveClosure("b"); // 2 != 3 -> rebuild again
		assert.deepEqual(dump(file).cursor, ["s1", "3"]);
		assert.deepEqual(names(file), ["A", "B", "C"]);
		store.close();
	});
});

// ── X: same-txn ──
describe("X same transaction", () => {
	const build = (file: string, g: FakeGraph, fault: () => Fault | null) => {
		let cur: SqlDriver | null = null; let faulty: FaultyDriver | null = null;
		const store = openProjectionStore({
			file, storeId: "s1", graph: g,
			wrapDriver: (d) => {
				cur = d;
				const pick = () => (cur ?? d);
				return {
					get engine() { return d.engine; }, get engineVersion() { return d.engineVersion; },
					exec: (s) => pick().exec(s), run: (s, ...p) => pick().run(s, ...p), all: (s, ...p) => pick().all(s, ...p), get: (s, ...p) => pick().get(s, ...p),
					transaction: (fn) => pick().transaction(fn), seal: (m) => pick().seal(m), head: () => pick().head(), recover: () => pick().recover(), close: () => d.close(),
				} as SqlDriver;
			},
		});
		return {
			store,
			arm() { const f = fault(); if (f) { faulty = faultyDriver(cur!, f); (cur as unknown) = faulty; } },
			get fired() { return faulty?.fired ?? false; },
			get writes() { return faulty?.writes.length ?? 0; },
			disarm() { faulty = null; },
		};
	};
	const graphAt = (n: number) => {
		const g = new FakeGraph();
		for (let i = 0; i < n; i++) g.nodes.push(nodeLine(`n${i}`, `N${i}`, `word${i} shared`, [`alias${i}`]));
		for (let i = 1; i < n; i++) g.chains.push(chainLine([`n${i - 1}`], `n${i}`));
		g.rev = n; return g;
	};

	it("a fault at every write step of a rebuild leaves the old rows and the old cursor, then recovers", () => {
		// count the writes of one rebuild first (a fault that never fires)
		const probeFile = newFile(); const pg = graphAt(2);
		const probe = build(probeFile, pg, () => ({ kind: "before", nth: 1_000_000 }));
		pg.nodes.push(nodeLine("n9", "N9", "x")); pg.rev++;
		probe.arm(); probe.store.deriveClosure("n1"); const writes = probe.writes; probe.store.close();
		assert.ok(writes > 15, `rebuild too small to be a test: ${writes} writes`);
		let fired = 0;
		for (const kind of ["before", "after", "enospc"] as const) {
			for (let nth = 1; nth <= writes; nth++) {
				const file = newFile(); const g = graphAt(2);
				let fault: Fault | null = null;
				const rig = build(file, g, () => fault);
				const old = dump(file);
				assert.deepEqual(old.rows, refRows(g.nodes, g.chains));
				g.nodes.push(nodeLine("n9", "N9", "x")); g.rev++;
				fault = { kind, nth }; rig.arm();
				assert.throws(() => rig.store.deriveClosure("n1"));
				assert.ok(rig.fired, `${kind} #${nth} never fired`); fired++;
				assert.deepEqual(dump(file), old, `${kind} #${nth}: rows or cursor changed`);
				rig.disarm(); fault = null;
				rig.store.deriveClosure("n1");
				assert.deepEqual(dump(file).rows, refRows(g.nodes, g.chains));
				assert.deepEqual(dump(file).cursor, ["s1", String(g.rev)]);
				rig.store.close();
			}
		}
		assert.equal(fired, 3 * writes);
	});
	it("a failure on COMMIT keeps the old rows and cursor", () => {
		const file = newFile(); const g = graphAt(2); let fault: Fault | null = null;
		const rig = build(file, g, () => fault);
		const old = dump(file);
		g.rev++; fault = { kind: "commit" }; rig.arm();
		assert.throws(() => rig.store.deriveClosure("n1"));
		assert.ok(rig.fired);
		assert.deepEqual(dump(file), old);
		rig.store.close();
	});
});

// ── H: projection_hash ──
describe("H projection_hash", () => {
	it("each input changes the pure hash", () => {
		const base = projectionHash("ddl", 1, "fold");
		assert.equal(projectionHash("ddl", 1, "fold"), base);
		assert.match(base, /^[0-9a-f]{64}$/);
		assert.notEqual(projectionHash("ddl2", 1, "fold"), base);
		assert.notEqual(projectionHash("ddl", 2, "fold"), base);
		assert.notEqual(projectionHash("ddl", 1, "fold2"), base);
		assert.notEqual(projectionHash("dd", 1, "lfold"), projectionHash("ddl", 1, "fold"));
	});
	it("the stored hash is the one built from the real DDL and LOGIC_VERSION", () => {
		const g = new FakeGraph(); const file = newFile();
		openProjectionStore({ file, storeId: "s1", graph: g }).close();
		const d = openNodeSqlite(file);
		const stored = d.get<{ value: string }>("SELECT value FROM proj_meta WHERE key = 'projection_hash'")?.value;
		d.close();
		assert.equal(stored, CURRENT_PROJECTION_HASH);
		// the fold-source input is really in there: the hash cannot equal one built without it
		assert.notEqual(CURRENT_PROJECTION_HASH, projectionHash(PROJECTION_DDL, LOGIC_VERSION, ""));
	});
	const seeded = () => {
		const g = new FakeGraph(); g.nodes.push(nodeLine("a", "A", "alpha")); g.rev = 1;
		const file = newFile(); openProjectionStore({ file, storeId: "s1", graph: g }).close();
		return { g, file };
	};
	const tables = (file: string) => { const d = openNodeSqlite(file); try { return d.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'node_fts_%' ORDER BY name").map((r) => r.name); } finally { d.close(); } };
	it("a different hash on disk drops everything (junk table included) and rebuilds at open", () => {
		const { g, file } = seeded();
		const expectedTables = tables(file);
		raw(file, "UPDATE proj_meta SET value = 'old' WHERE key = 'projection_hash'; CREATE TABLE junk (x); INSERT INTO node VALUES ('zz','Z','z','t');");
		openProjectionStore({ file, storeId: "s1", graph: g }).close();
		assert.deepEqual(tables(file), expectedTables);
		assert.deepEqual(dump(file).rows, refRows(g.nodes, g.chains));
	});
	it("an old-shape node table and a missing hash are replaced from the DDL", () => {
		const { g, file } = seeded();
		raw(file, "DROP TABLE node; CREATE TABLE node (foo); DELETE FROM proj_meta WHERE key = 'projection_hash';");
		openProjectionStore({ file, storeId: "s1", graph: g }).close();
		assert.deepEqual(dump(file).rows, refRows(g.nodes, g.chains));
	});
	it("a junk proj_meta, a junk proj_cursor and a dropped fts table are all rebuilt", () => {
		const { g, file } = seeded();
		raw(file, "DROP TABLE proj_meta; CREATE TABLE proj_meta (foo); DROP TABLE proj_cursor; DROP TABLE node_fts;");
		openProjectionStore({ file, storeId: "s1", graph: g }).close();
		assert.deepEqual(dump(file).rows, refRows(g.nodes, g.chains));
		assert.deepEqual(dump(file).cursor, ["s1", "1"]);
	});
	it("a file that is not a projection store at all (other tables only) is rebuilt", () => {
		const file = newFile(); raw(file, "CREATE TABLE something_else (a, b);");
		const g = new FakeGraph(); g.nodes.push(nodeLine("a", "A", "alpha")); g.rev = 4;
		openProjectionStore({ file, storeId: "s9", graph: g }).close();
		assert.ok(!tables(file).includes("something_else"));
		assert.deepEqual(dump(file).cursor, ["s9", "4"]);
	});
});

// ── C: closure CTE ──
describe("C closure CTE", () => {
	const CPOOL = ["a", "b", "c", "d"];
	const lines = fc.array(fc.record({ p: fc.array(fc.constantFrom(...CPOOL), { minLength: 1, maxLength: 3 }), c: fc.constantFrom(...CPOOL) }), { maxLength: 9 });
	it("terminates on cycles (self-loops, 2-cycles) and equals the BFS reference, target included", () => {
		const g = new FakeGraph(); const file = newFile();
		const store = openProjectionStore({ file, storeId: "s1", graph: g });
		const check = (ls: Array<{ p: string[]; c: string }>) => {
			g.chains = ls.map((l) => chainLine(l.p, l.c)); g.nodes = CPOOL.map((id) => nodeLine(id, id, id)); g.rev++;
			for (const t of [...CPOOL, "unknown"]) {
				const got = store.deriveClosure(t);
				assert.deepEqual(got, bfs(g.chains, t));
				assert.ok(got.includes(t));
			}
		};
		fc.assert(fc.property(lines, (ls) => check(ls)), {
			numRuns: 150,
			examples: [[[{ p: ["a"], c: "a" }]], [[{ p: ["a"], c: "b" }, { p: ["b"], c: "a" }]], [[{ p: ["a", "b"], c: "c" }, { p: ["c"], c: "a" }, { p: ["d"], c: "d" }]]],
		});
		store.close();
	});
	it("an unknown target is just [target]", () => {
		const g = new FakeGraph(); g.rev = 1;
		const store = openProjectionStore({ file: newFile(), storeId: "s1", graph: g });
		assert.deepEqual(store.deriveClosure("nope"), ["nope"]);
		store.close();
	});
});

// ── S: search ──
describe("S search", () => {
	const mk = () => {
		const g = new FakeGraph(); g.rev = 1;
		g.nodes.push(nodeLine("n_b", "tie", "common words here"), nodeLine("n_a", "tie", "common words here"), nodeLine("n_c", "tie", "common words here"), nodeLine("n_u", "U", "uniqueword only", ["also-an-alias"]));
		let calls = 0;
		const store = openProjectionStore({ file: newFile(), storeId: "s1", graph: g, wrapDriver: (d) => ({ ...d, all: (s, ...p) => { calls++; return d.all(s, ...p); }, get: (s, ...p) => { calls++; return d.get(s, ...p); }, run: d.run, exec: d.exec, transaction: (f) => d.transaction(f), close: () => d.close() }) as SqlDriver });
		return { store, queries: () => calls, g };
	};
	it("returns node ids only, finds a unique word (also via an alias), ties break by id", () => {
		const { store } = mk();
		assert.deepEqual(store.search("uniqueword", 10), ["n_u"]);
		assert.deepEqual(store.search("alias", 10), ["n_u"]);
		assert.deepEqual(store.search("common", 10), ["n_a", "n_b", "n_c"]);
		assert.deepEqual(store.search("common", 2), ["n_a", "n_b"]);
		assert.deepEqual(store.search("COMMON uniqueword", 10).sort(), ["n_a", "n_b", "n_c", "n_u"]);
		store.close();
	});
	it("empty and punctuation-only input returns [] without running a query", () => {
		const { store, queries } = mk();
		const before = queries();
		for (const q of ["", "   ", "\"", "-*:^()", "...!!!", "\n\t"]) assert.deepEqual(store.search(q, 5), []);
		assert.equal(queries(), before);
		assert.deepEqual(store.search("common", 0), []);
		store.close();
	});
	it("FTS syntax and arbitrary text never throw", () => {
		const { store } = mk();
		const ids = new Set(["n_a", "n_b", "n_c", "n_u"]);
		const check = (q: string) => { const r = store.search(q, 5); assert.ok(r.every((id) => ids.has(id))); };
		for (const q of ['"', 'AND', 'OR', 'NOT', 'NEAR(', 'NEAR(a b)', '*', '-', ':', 'a:b', '^a', '(a', 'a)', 'common AND', '"common', 'node_id:n_a', '{x}', 'common"" OR "x']) check(q);
		fc.assert(fc.property(fc.string({ maxLength: 40 }), check), { numRuns: 200 });
		fc.assert(fc.property(fc.string({ unit: "binary", maxLength: 40 }), check), { numRuns: 200 });
		fc.assert(fc.property(fc.string({ unit: fc.constantFrom('"', "*", "-", ":", "(", ")", "^", " ", "a", "AND", "NEAR", "é", "中"), maxLength: 30 }), check), { numRuns: 300 });
		store.close();
	});
});

// ── P: two processes ──
const CHILD = process.env.LH_PROJ_CHILD === "1";
/** The graph a child serves at revision r: nodes n0..n(size-1), chain n(i-1) -> n(i). Size differs per revision. */
const graphFor = (rev: number) => {
	const g = new FakeGraph(); g.rev = rev;
	for (let i = 0; i < rev * 40; i++) g.nodes.push(nodeLine(`n${i}`, `N${i}`, `w${i} shared`, [`a${i}`]));
	for (let i = 1; i < rev * 40; i++) g.chains.push({ id: `arg_${i}`, premises: [`n${i - 1}`], conclusion: `n${i}`, provenance: [], createdAt: "t1" });
	return g;
};
if (CHILD) {
	const [file, barrier, ready, revArg] = process.argv.slice(2) as [string, string, string, string];
	const g = graphFor(Number(revArg));
	fs.writeFileSync(ready, "1");
	while (!fs.existsSync(barrier)) { /* spin: both children start together */ }
	const store = openProjectionStore({ file, storeId: "s1", graph: g });
	for (let i = 0; i < 12; i++) { store.deriveClosure("n3"); store.search("shared", 3); }
	store.close();
	process.exit(0);
}
describe("P two processes", () => {
	it("rebuilds of one file at different revisions never leave rows that disagree with the cursor", async () => {
		const self = new URL(import.meta.url).pathname;
		for (let round = 0; round < 3; round++) {
			const file = newFile(); const barrier = `${file}.go`;
			const revs = [2, 5];
			const kids = revs.map((rev, i) => {
				const ready = `${file}.ready${i}`;
				const child = spawn(process.execPath, ["--import", "tsx", self, file, barrier, ready, String(rev)], { env: { ...process.env, LH_PROJ_CHILD: "1", NODE_ENV: "test" }, stdio: ["ignore", "ignore", "pipe"] });
				let err = ""; child.stderr.on("data", (d) => { err += d; });
				const done = new Promise<void>((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${rev} exited ${code}: ${err.slice(0, 600)}`)))));
				return { ready, child, done };
			});
			try {
				const deadline = Date.now() + 30_000;
				while (!kids.every((k) => fs.existsSync(k.ready))) { if (Date.now() > deadline) throw new Error("children never became ready"); await new Promise((r) => setTimeout(r, 20)); }
				fs.writeFileSync(barrier, "go");
				await Promise.all(kids.map((k) => k.done));
			} finally { for (const k of kids) if (k.child.exitCode === null) k.child.kill(); }
			const got = dump(file);
			const rev = Number(got.cursor[1]);
			assert.ok(revs.includes(rev), `cursor revision ${rev}`);
			const g = graphFor(rev);
			assert.deepEqual(got.rows, refRows(g.nodes, g.chains));
		}
	});
});
