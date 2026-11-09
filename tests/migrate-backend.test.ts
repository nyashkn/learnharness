/**
 * M1 storage migration tool (bead lh-smv). Expected values come from small models written here, never from the code under test.
 *
 *   N normaliser properties        R round trip (arbitrary dirty input)     S source never modified
 *   W uncheckpointed WAL / dirty DoltLite working set                       C crash at every checkpoint, resume, SIGKILL
 *   M marker last, verify           L line_format      X refusals (migrate AND export)      B backup, export out, CLI
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { runCli } from "../scripts/lh-storage";
import { StorageVersionError } from "../src/store/graph-format";
import { BACKENDS, markerFile, type Backend } from "../src/store/marker";
import { exportStore, migrateBackend, MIGRATE_TEXT, normaliseLedger, renderExport, sqlDifference, type Snapshot } from "../src/store/migrate-backend";
import { PURGE_TEXT } from "../src/store/sql/purge";
import { openDoltlite } from "../src/store/sql/drivers/doltlite";
import { openNodeSqlite } from "../src/store/sql/drivers/node-sqlite";
import { openGraphStore } from "../src/store/sql/graph-store";
import { acquireStoreLock, StoreLockedError, type StoreLock } from "../src/store/sql/lock";
import type { SqlDriver } from "../src/store/sql/driver";

// ─── rig ─────────────────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migrate-"));
let counter = 0;
const mk = (): string => {
	const d = path.join(root, `d${counter++}`);
	fs.mkdirSync(d, { recursive: true });
	return d;
};
after(() => fs.rmSync(root, { recursive: true, force: true }));

let clock = Date.UTC(2026, 0, 1);
/** Every call a new stamp: two fresh runs in one folder never share a backup dir. */
const now = (): Date => new Date((clock += 1000));

/** migrateBackend with the test-only doltlite-target switch on (D3 removes the refusal and the switch). */
const mig = (dir: string, to: Backend, opts: Parameters<typeof migrateBackend>[2] = {}) => migrateBackend(dir, to, { allowDoltliteTarget: true, ...opts });
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const storeName = (b: "sqlite" | "doltlite") => (b === "sqlite" ? "graph.sqlite" : "graph.doltlite");
const openRO = (file: string, b: "sqlite" | "doltlite"): SqlDriver => (b === "sqlite" ? openNodeSqlite(file, { readOnly: true }) : openDoltlite(file, { readOnly: true }));
const openRW = (file: string, b: "sqlite" | "doltlite", lock?: StoreLock): SqlDriver => (b === "sqlite" ? openNodeSqlite(file) : openDoltlite(file, { lock }));

/** Every file under dir: relative path -> sha. SQLite side files that a read-only open may leave empty are not content (recorded as a FACT). */
function tree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string): void => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else {
				const buf = fs.readFileSync(p);
				if (e.name.endsWith("-shm") || (e.name.endsWith("-wal") && buf.length === 0)) continue; // engine side files a read-only open leaves
				out[path.relative(dir, p)] = sha(buf);
			}
		}
	};
	walk(dir);
	return out;
}
const exportTree = (dir: string): Record<string, string> => tree(dir);

// ─── content ─────────────────────────────────────────────────────────────────

interface Raw {
	nodes: string;
	chains: string;
	sessions: string;
	coverage: string;
	sources?: string;
	org?: string;
	format?: string;
	positions?: string;
}
const GRAPH_FILES: Record<keyof Raw, string> = { nodes: "nodes.jsonl", chains: "chains.jsonl", sessions: "sessions.jsonl", coverage: "coverage.jsonl", sources: "sources.json", org: "source-organization.json", format: "format.json", positions: "positions.json" };

function writeFolder(dir: string, raw: Raw): void {
	fs.mkdirSync(path.join(dir, "graph"), { recursive: true });
	for (const k of Object.keys(GRAPH_FILES) as (keyof Raw)[]) {
		const text = raw[k];
		if (text !== undefined) fs.writeFileSync(path.join(dir, "graph", GRAPH_FILES[k]), text, "utf8");
	}
}

const bytes = (...parts: (string | number[])[]): Buffer => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : Buffer.from(p))));
const LONE_SURROGATE_ID = '{"a\\ud800b":{"id":"x"}}'; // valid JSON and valid UTF-8; JSON.parse makes the lone surrogate
const LATIN1_E9 = [0xe9]; // é in Latin-1: not valid UTF-8 when a quote follows it
const graphFile = (dir: string, name: string): string => path.join(dir, "graph", name);

/** Dirty on purpose: CRLF, blank interior lines, a corrupt line, duplicates, unicode, odd whitespace, a parseable unterminated tail. */
const DIRTY: Raw = {
	nodes: `{"id":"n1","name":"é☃"}\r\n\r\n{"id":"n1","name":"é☃"}\n  \n not json \n{"id":"n2"} \r\n{"id":"n3"}`,
	chains: `{"c":1}\n{"c":2}\n{"c":`,
	sessions: `{"s":1}\r\n`,
	coverage: "",
	sources: JSON.stringify({ b: { id: "b", filePath: "/b", importedAt: "t" }, a: { id: "a", filePath: "/a", importedAt: "t", extras: [1, { x: null }] }, odd: 5 }, null, 2),
	org: JSON.stringify({ version: 1, folders: [] }),
	format: JSON.stringify({ version: 1 }),
	positions: '{"positions":{"n1":{"x":1,"y":2}},"updatedAt":"t"}',
};

/** Rows for a SQL store, already normalised (written here, not through the code under test). */
interface Rows {
	nodes: string[];
	chains: string[];
	checkpoints: string[];
	coverage: string[];
	sources: [string, string][];
	org?: string;
}
const ROWS: Rows = {
	nodes: ['{"id":"n1","name":"é☃"}', '{"id":"n1","name":"é☃"}', " not json ", '{"id":"n2"}'],
	chains: ['{"c":1}', '{"c":2}'],
	checkpoints: ['{"s":1}'],
	coverage: ['{"v":1}'],
	sources: [["a", '{"id":"a","filePath":"/a","importedAt":"t"}'], ["b", '{"id":"b","filePath":"/b","importedAt":"t"}']],
	org: '{"version":1,"folders":[]}',
};
const STALE: Rows = { nodes: ['{"id":"old"}'], chains: [], checkpoints: [], coverage: [], sources: [] };
const TABLE = { nodes: "ledger_nodes", chains: "ledger_chains", checkpoints: "ledger_checkpoints", coverage: "ledger_coverage" } as const;

const writeMarker = (dir: string, backend: Backend): void => fs.writeFileSync(markerFile(dir), `${JSON.stringify({ backend, layout: 1 }, null, "\t")}\n`);

/** A real store built through openGraphStore (the shipped schema), rows inserted with SQL here. */
function seedSql(dir: string, b: "sqlite" | "doltlite", rows: Rows, marker: boolean): void {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, storeName(b));
	const lock = b === "doltlite" ? acquireStoreLock(file) : undefined;
	const db = openRW(file, b, lock);
	try {
		openGraphStore({ db, file, lhVersion: "test", positions: { read: () => ({}), write: () => {} }, log: () => {} });
		db.transaction(() => {
			for (const k of ["nodes", "chains", "checkpoints", "coverage"] as const) rows[k].forEach((l, i) => db.run(`INSERT INTO ${TABLE[k]} (seq, line_json) VALUES (?, ?)`, i + 1, l));
			for (const [id, json] of rows.sources) db.run("INSERT INTO sources (id, record_json) VALUES (?, ?)", id, json);
			if (rows.org !== undefined) db.run("INSERT INTO documents (key, json) VALUES ('source-organization', ?)", rows.org);
		});
		db.seal("seed");
	} finally {
		db.close();
		lock?.release();
	}
	if (marker) writeMarker(dir, b);
}

/** The state a migration meets: a source in `from`, and (as M1 leaves them) stale data already in the target. */
function buildState(dir: string, from: Backend, to: Backend): void {
	if (from === "file") writeFolder(dir, DIRTY);
	else seedSql(dir, from, ROWS, true);
	if (to === "file") writeFolder(dir, { nodes: '{"id":"stale"}\n', chains: "", sessions: "", coverage: "", sources: "{}", org: '{"stale":true}' });
	else seedSql(dir, to, STALE, false);
}

const DIRS: [Backend, Backend][] = [["file", "sqlite"], ["file", "doltlite"], ["sqlite", "file"], ["sqlite", "doltlite"], ["doltlite", "file"], ["doltlite", "sqlite"]];

/** The files that make up a source, with content hash and mtime. */
function sourceState(dir: string, from: Backend): Record<string, string> {
	const out: Record<string, string> = {};
	const files = from === "file" ? fs.readdirSync(path.join(dir, "graph")).map((n) => path.join(dir, "graph", n)) : [path.join(dir, storeName(from)), path.join(dir, `${storeName(from)}-wal`)];
	for (const f of files) {
		const st = fs.statSync(f, { throwIfNoEntry: false });
		if (st && !(f.endsWith("-wal") && st.size === 0)) out[path.relative(dir, f)] = `${sha(fs.readFileSync(f))}@${st.mtimeMs}`;
	}
	return out;
}
const metaOf = (dir: string, b: "sqlite" | "doltlite", key: string): string | undefined => {
	const db = openRO(path.join(dir, storeName(b)), b);
	try {
		return db.get<{ value: string }>("SELECT value FROM lh_meta WHERE key = ?", key)?.value;
	} finally {
		db.close();
	}
};
const doltLogCount = (dir: string): number => {
	const db = openRO(path.join(dir, "graph.doltlite"), "doltlite");
	try {
		return db.get<{ c: number }>("SELECT count(*) AS c FROM dolt_log")?.c ?? 0;
	} finally {
		db.close();
	}
};
const readMarkerBytes = (dir: string): string | undefined => fs.existsSync(markerFile(dir)) ? fs.readFileSync(markerFile(dir), "utf8") : undefined;
const exportOf = (dir: string): Record<string, string> => {
	const out = path.join(mk(), "e");
	exportStore(dir, out, { now });
	return exportTree(out);
};

// ─── N normaliser ────────────────────────────────────────────────────────────

/** Independent model: walk the text with indexOf. */
function model(text: string): { lines: string[]; crlf: number; blank: number; torn: number } {
	const out = { lines: [] as string[], crlf: 0, blank: 0, torn: 0 };
	let rest = text;
	for (;;) {
		const nl = rest.indexOf("\n");
		const terminated = nl >= 0;
		let seg = terminated ? rest.slice(0, nl) : rest;
		rest = terminated ? rest.slice(nl + 1) : "";
		if (!terminated && seg === "") break;
		let k = seg.length;
		while (k > 0 && seg[k - 1] === "\r") k--;
		if (k < seg.length) out.crlf++;
		seg = seg.slice(0, k);
		if (/^\s*$/.test(seg)) out.blank++;
		else if (!terminated && !parses(seg.trim())) out.torn++;
		else out.lines.push(seg);
		if (!terminated) break;
	}
	return out;
}
function parses(s: string): boolean {
	try {
		JSON.parse(s);
		return true;
	} catch {
		return false;
	}
}

const piece = fc.oneof(
	fc.jsonValue().map((v) => JSON.stringify(v)),
	fc.string({ unit: "binary" }),
	fc.constantFrom("", " ", "\t", "\r", "\u00a0", "\ufeff", "{", '{"a":', "  {}  ", "\r\r"),
);
const terminator = fc.constantFrom("\n", "\r\n", "\r\r\n", "\n\n", " \n", "\r\n\r\n");
/** Dirty ledger text: pieces with mixed terminators and one of several tails. */
const ledgerText: fc.Arbitrary<string> = fc
	.tuple(fc.array(fc.tuple(piece, terminator), { maxLength: 8 }), fc.oneof(fc.constant(""), piece, fc.constant("\r"), fc.constant('{"torn":')))
	.map(([ls, tail]) => ls.map(([p, t]) => p + t).join("") + tail);

describe("N normaliser", () => {
	test("N1 matches the model, with the counts", () => {
		fc.assert(fc.property(ledgerText, (t) => assert.deepEqual(normaliseLedger(t), model(t))), { numRuns: 400 });
	});
	test("N2 fixed point: rendering the lines and normalising again changes and drops nothing", () => {
		fc.assert(
			fc.property(ledgerText, (t) => {
				const first = normaliseLedger(t);
				const again = normaliseLedger(first.lines.map((l) => `${l}\n`).join(""));
				assert.deepEqual(again, { lines: first.lines, crlf: 0, blank: 0, torn: 0 });
			}),
			{ numRuns: 400, examples: [["{}\r\r\n"], ["a\r\n\r\n\r"], ['{"a":1}\r']] },
		);
	});
	test("N3 an unterminated tail: parseable is KEPT, torn is dropped and counted, blank is blank", () => {
		assert.deepEqual(normaliseLedger('{"a":1}\n{"b":2}'), { lines: ['{"a":1}', '{"b":2}'], crlf: 0, blank: 0, torn: 0 });
		assert.deepEqual(normaliseLedger('{"a":1}\n{"b":'), { lines: ['{"a":1}'], crlf: 0, blank: 0, torn: 1 });
		assert.deepEqual(normaliseLedger('{"a":1}\n  '), { lines: ['{"a":1}'], crlf: 0, blank: 1, torn: 0 });
		assert.deepEqual(normaliseLedger('{"a":1}\n  \n{"b":2}\n'), { lines: ['{"a":1}', '{"b":2}'], crlf: 0, blank: 1, torn: 0 });
		assert.deepEqual(normaliseLedger("not json\n"), { lines: ["not json"], crlf: 0, blank: 0, torn: 0 }); // corrupt but terminated: kept verbatim
		assert.deepEqual(normaliseLedger(""), { lines: [], crlf: 0, blank: 0, torn: 0 });
	});
});

// ─── R round trip ────────────────────────────────────────────────────────────

const sourcesText = fc.array(fc.tuple(fc.string(), fc.oneof(fc.jsonValue(), fc.record({ id: fc.string(), filePath: fc.string(), importedAt: fc.string() })))).map((es) => JSON.stringify(Object.fromEntries(es), null, 2));
const rawArb: fc.Arbitrary<Raw> = fc.record(
	{
		nodes: ledgerText,
		chains: ledgerText,
		sessions: ledgerText,
		coverage: ledgerText,
		sources: sourcesText,
		org: fc.jsonValue().map((v) => JSON.stringify(v)),
		format: fc.constant('{"version":1}'),
		positions: fc.constant('{"positions":{},"updatedAt":"t"}'),
	},
	{ requiredKeys: ["nodes", "chains", "sessions", "coverage"] },
);

let refusedForNul = 0;
/** x -> export E1 -> copy -> migrate through `chain` -> export E2. Returns false when verify refused (then nothing may have changed). */
function roundTrip(raw: Raw, chain: Backend[]): boolean {
	const x = mk();
	writeFolder(x, raw);
	const e1 = path.join(mk(), "e1");
	exportStore(x, e1);
	const f = mk();
	fs.cpSync(path.join(e1, "graph"), path.join(f, "graph"), { recursive: true });
	try {
		for (const b of chain) mig(f, b, { now });
	} catch (error) {
		const text = Object.values(raw).join("");
		assert.match((error as Error).message, /verification failed/, "the only refusal a round trip may meet is verify");
		assert.ok(text.includes("\u0000"), `verify refused without a NUL in the input: ${(error as Error).message}`);
		assert.equal(readMarkerBytes(f)?.includes(chain[chain.length - 1] as string) ?? false, false, "a refused verify leaves no marker for the failed step");
		refusedForNul++;
		return false;
	}
	const e2 = path.join(mk(), "e2");
	exportStore(f, e2);
	assert.deepEqual(exportTree(e2), exportTree(e1), `export(import(export(x))) must equal export(x) through ${chain.join(" -> ")}`);
	return true;
}

describe("R round trip", () => {
	const examples: [Raw][] = [[DIRTY], [{ nodes: "{}\r\r\n", chains: "", sessions: "\n", coverage: "x\r" }], [{ nodes: "", chains: "", sessions: "", coverage: "", sources: '{"__proto__":{"id":"p"},"1":2,"0":3}' }]];
	test("R1 file -> sqlite", () => {
		fc.assert(fc.property(rawArb, (raw) => void roundTrip(raw, ["sqlite"])), { numRuns: 25, examples });
	});
	test("R2 file -> doltlite", () => {
		fc.assert(fc.property(rawArb, (raw) => void roundTrip(raw, ["doltlite"])), { numRuns: 8, examples });
	});
	test("R3 chain file -> sqlite -> doltlite -> file", () => {
		fc.assert(fc.property(rawArb, (raw) => void roundTrip(raw, ["sqlite", "doltlite", "file"])), { numRuns: 6, examples: [[DIRTY]] });
	});
	test("R4 NUL in a line: record what the engines do (FACT); a lossy engine must be refused by verify, never silently accepted", () => {
		for (const b of ["sqlite", "doltlite"] as const) {
			const ok = roundTrip({ nodes: 'a\u0000b\n{"x":"\\u0000"}\n', chains: "", sessions: "", coverage: "" }, [b]);
			console.log(`FACT NUL inside a ledger line on ${b}: ${ok ? "survives byte-identically" : "verify refused it"}`);
		}
		console.log(`FACT round-trip properties: ${refusedForNul} generated cases were refused by verify (all contained NUL)`);
	});
});

// ─── S source never modified ─────────────────────────────────────────────────

describe("S source never modified", () => {
	for (const [from, to] of DIRS) {
		test(`S ${from} -> ${to}: bytes and mtime unchanged on success`, () => {
			const dir = mk();
			buildState(dir, from, to);
			const before = sourceState(dir, from);
			const names = new Set(fs.readdirSync(dir));
			const logBefore = from === "doltlite" ? doltLogCount(dir) : 0;
			const r = mig(dir, to, { now });
			assert.deepEqual(sourceState(dir, from), before);
			if (from === "doltlite") assert.equal(doltLogCount(dir), logBefore, "dolt_log unchanged");
			const extra = fs.readdirSync(dir).filter((n) => !names.has(n) && n.startsWith(storeName(from === "file" ? "sqlite" : (from as "sqlite")).slice(0, 8)) && /-(wal|shm)$/.test(n));
			if (from !== "file") console.log(`FACT read-only ${from} open leaves beside the store: ${extra.join(", ") || "nothing"}`);
			assert.equal(r.resumed, false);
		});
	}
	test("S a sqlite source in rollback-journal mode stays in it: a writable open would switch the file to WAL", () => {
		const dir = mk();
		seedSql(dir, "sqlite", ROWS, true);
		const file = path.join(dir, "graph.sqlite");
		const db = openRW(file, "sqlite");
		db.exec("PRAGMA journal_mode = DELETE");
		db.close();
		const WRITE_VERSION = 18; // SQLite file header: 1 = rollback journal, 2 = WAL
		assert.equal(fs.readFileSync(file)[WRITE_VERSION], 1, "the fixture really is in rollback-journal mode");
		const before = sourceState(dir, "sqlite");
		exportStore(dir, path.join(mk(), "out"), { now });
		assert.deepEqual(sourceState(dir, "sqlite"), before, "export");
		mig(dir, "file", { now });
		assert.deepEqual(sourceState(dir, "sqlite"), before, "migrate");
		assert.equal(fs.readFileSync(file)[WRITE_VERSION], 1);
	});
	test("S sidecar exemption (owner decision, named in the usage): on a WAL sqlite source only -shm and an empty -wal may change; the main store file stays byte-identical", () => {
		const dir = mk();
		seedSql(dir, "sqlite", ROWS, true);
		const file = path.join(dir, "graph.sqlite");
		const raw = (): Record<string, string> => Object.fromEntries(fs.readdirSync(dir).filter((n) => n.startsWith("graph.sqlite")).map((n) => [n, sha(fs.readFileSync(path.join(dir, n)))]));
		const before = raw();
		const mtime = fs.statSync(file).mtimeMs;
		exportStore(dir, path.join(mk(), "out"), { now });
		const after = raw();
		assert.equal(after["graph.sqlite"], before["graph.sqlite"], "the main store file is byte-identical");
		assert.equal(fs.statSync(file).mtimeMs, mtime);
		for (const n of Object.keys(after)) if (after[n] !== before[n]) assert.match(n, /^graph\.sqlite-(shm|wal)$/, `only a sidecar may differ: ${n}`);
		if (fs.existsSync(`${file}-wal`) && before["graph.sqlite-wal"] === undefined) assert.equal(fs.statSync(`${file}-wal`).size, 0, "a -wal that appears is empty");
		mig(dir, "file", { now });
		assert.equal(sha(fs.readFileSync(file)), before["graph.sqlite"], "migrate leaves it byte-identical too");
		for (const usage of [MIGRATE_TEXT.usage, MIGRATE_TEXT.exportUsage]) assert.match(usage, /-wal and -shm/);
	});
	test("S crash at every checkpoint also leaves the source alone (6 directions, one point each)", () => {
		for (const [from, to] of DIRS) {
			const dir = mk();
			buildState(dir, from, to);
			const before = sourceState(dir, from);
			assert.throws(() => mig(dir, to, { now, checkpoint: (n) => { if (n === "after:chains") throw new Error("crash"); } }), /crash/);
			assert.deepEqual(sourceState(dir, from), before, `${from} -> ${to}`);
		}
	});
});

// ─── W uncheckpointed WAL and dirty working set ──────────────────────────────

describe("W data that is not in the main file yet", () => {
	test("W1 sqlite source with uncheckpointed WAL frames is migrated", () => {
		const dir = mk();
		seedSql(dir, "sqlite", ROWS, true);
		const writer = openNodeSqlite(path.join(dir, "graph.sqlite"));
		try {
			writer.exec("PRAGMA wal_autocheckpoint = 0");
			writer.run("INSERT INTO ledger_nodes (seq, line_json) VALUES (?, ?)", 99, '{"id":"only-in-wal"}');
			assert.ok(fs.statSync(path.join(dir, "graph.sqlite-wal")).size > 0, "control: the frame sits in the WAL");
			mig(dir, "file", { now });
		} finally {
			writer.close();
		}
		assert.match(fs.readFileSync(path.join(dir, "graph", "nodes.jsonl"), "utf8"), /only-in-wal/);
	});
	test("W2 doltlite source with a dirty working set is migrated, and stays dirty", () => {
		const dir = mk();
		seedSql(dir, "doltlite", ROWS, true);
		const file = path.join(dir, "graph.doltlite");
		const lock = acquireStoreLock(file);
		const db = openDoltlite(file, { lock });
		db.run("INSERT INTO ledger_nodes (seq, line_json) VALUES (?, ?)", 99, '{"id":"uncommitted"}'); // no seal
		db.close();
		lock.release();
		const logs = doltLogCount(dir);
		mig(dir, "file", { now });
		assert.match(fs.readFileSync(path.join(dir, "graph", "nodes.jsonl"), "utf8"), /uncommitted/);
		assert.equal(doltLogCount(dir), logs, "no recover, no commit on the source");
		const ro = openRO(file, "doltlite");
		assert.match(JSON.stringify(ro.all("SELECT line_json FROM ledger_nodes")), /uncommitted/, "still in the working set");
		ro.close();
	});
});

// ─── C crash at every checkpoint, resume ─────────────────────────────────────

const ENTITY = ["meta", "nodes", "chains", "coverage", "checkpoints", "sources", "organization"];
const CHECKPOINTS = ["after-backup", "after-journal", ...ENTITY.flatMap((e) => [`commit:${e}`, `after:${e}`]), "before-verify", "after-verify", "after-journal-removed", "after-marker"];
/** Entities that are in journal.done when the run died at `name`. */
const doneAt = (name: string): string[] => {
	if (name === "after-backup" || name === "after-journal") return [];
	if (name.startsWith("commit:")) return ENTITY.slice(0, ENTITY.indexOf(name.slice(7)));
	if (name.startsWith("after:")) return ENTITY.slice(0, ENTITY.indexOf(name.slice(6)) + 1);
	return ENTITY;
};
const journalPath = (dir: string) => path.join(dir, "storage-migrate.journal.json");

function reference(from: Backend, to: Backend): { exportTree: Record<string, string>; revision?: string } {
	const dir = mk();
	buildState(dir, from, to);
	mig(dir, to, { now });
	return { exportTree: exportOf(dir), revision: to === "file" ? undefined : metaOf(dir, to, "revision") };
}

describe("C crash at every checkpoint, then resume", () => {
	for (const [from, to] of DIRS) {
		test(`C ${from} -> ${to}`, () => {
			const ref = reference(from, to);
			for (const name of CHECKPOINTS) {
				const dir = mk();
				buildState(dir, from, to);
				const src = sourceState(dir, from);
				const markerBefore = readMarkerBytes(dir);
				const died = (n: string) => { if (n === name) throw new Error(`crash@${n}`); };
				assert.throws(() => mig(dir, to, { now, checkpoint: died }), new RegExp(`crash@${name}`), name);
				const ctx = `${from} -> ${to} @ ${name}`;
				assert.equal(fs.existsSync(path.join(dir, `${storeName(to === "file" ? "sqlite" : to)}.lock`)), false, `${ctx}: no lock left`);
				if (name !== "after-marker") assert.equal(readMarkerBytes(dir), markerBefore, `${ctx}: marker unchanged until the end`);
				else assert.equal(JSON.parse(readMarkerBytes(dir) ?? "{}").backend, to, ctx);
				if (name !== "after-marker") {
					const seen: string[] = [];
					const r = mig(dir, to, { now, checkpoint: (n) => void seen.push(n) });
					const journalExisted = !["after-backup", "after-journal-removed"].includes(name);
					assert.equal(r.resumed, journalExisted, `${ctx}: resumed`);
					if (r.resumed) for (const e of doneAt(name)) assert.ok(!seen.includes(`commit:${e}`), `${ctx}: ${e} was rewritten on resume`);
					if (name.startsWith("after:") && to !== "file") assert.equal(metaOf(dir, to, "revision"), ref.revision, `${ctx}: revision shows nothing done was redone`);
				}
				assert.deepEqual(exportOf(dir), ref.exportTree, `${ctx}: final state equals an uninterrupted run`);
				assert.deepEqual(JSON.parse(readMarkerBytes(dir) as string), { backend: to, layout: 1 }, ctx);
				assert.equal(fs.existsSync(journalPath(dir)), false, `${ctx}: journal gone`);
				assert.deepEqual(sourceState(dir, from), src, `${ctx}: source untouched`);
			}
		});
	}

	test("C-changed: the source changes between crash and resume: the run restarts and matches the NEW source", () => {
		for (const [from, to] of DIRS) {
			const change = (dir: string): void => {
				if (from === "file") fs.appendFileSync(path.join(dir, "graph", "nodes.jsonl"), '\n{"id":"added-later"}\n');
				else {
					const file = path.join(dir, storeName(from));
					const lock = acquireStoreLock(file);
					const db = openRW(file, from, lock);
					db.run("INSERT INTO ledger_nodes (seq, line_json) VALUES (50, ?)", '{"id":"added-later"}');
					db.seal("later");
					db.close();
					lock.release();
				}
			};
			const refDir = mk();
			buildState(refDir, from, to);
			change(refDir);
			mig(refDir, to, { now });
			const refTree = exportOf(refDir);

			const dir = mk();
			buildState(dir, from, to);
			assert.throws(() => mig(dir, to, { now, checkpoint: (n) => { if (n === "after:chains") throw new Error("crash"); } }), /crash/);
			change(dir);
			const r = mig(dir, to, { now });
			assert.equal(r.resumed, false, `${from} -> ${to}`);
			assert.deepEqual(exportOf(dir), refTree, `${from} -> ${to}`);
		}
	});

	test("C-gone: the half-built target was deleted after a crash: the rerun starts over from a fresh backup and completes", () => {
		for (const to of ["sqlite", "doltlite", "file"] as const) {
			const from = to === "file" ? "sqlite" : "file";
			const ref = reference(from, to);
			for (const name of ["after:nodes", "before-verify", "after-verify"]) {
				const dir = mk();
				buildState(dir, from, to);
				assert.throws(() => mig(dir, to, { now, checkpoint: (n) => { if (n === name) throw new Error("crash"); } }), /crash/);
				if (to === "file") fs.rmSync(graphFile(dir, "nodes.jsonl"));
				else for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dir, `${storeName(to)}${suffix}`), { force: true });
				const r = mig(dir, to, { now });
				assert.equal(r.resumed, false, `${to} @ ${name}`);
				assert.deepEqual(exportOf(dir), ref.exportTree, `${to} @ ${name}`);
				assert.equal(fs.existsSync(journalPath(dir)), false);
			}
		}
	});

	for (const to of ["sqlite", "doltlite"] as const) {
		test(`C-kill: a real SIGKILL mid-migration (file -> ${to}); the stale lock is reclaimed and the resume completes`, async () => {
			const ref = reference("file", to);
			const dir = mk();
			buildState(dir, "file", to);
			const scratch = mk();
			const script = path.join(scratch, "child.mjs");
			const ready = path.join(scratch, "ready");
			fs.writeFileSync(
				script,
				`import fs from "node:fs";
const [, , mod, dir, to, ready] = process.argv;
const { migrateBackend } = await import(mod);
migrateBackend(dir, to, { allowDoltliteTarget: true, checkpoint(n) { if (n === "after:chains") { fs.writeFileSync(ready, "x"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000); } } });
`,
			);
			const child = spawn(process.execPath, ["--import", "tsx", script, pathToFileURL(path.resolve("src/store/migrate-backend.ts")).href, dir, to, ready], { cwd: path.resolve("."), stdio: "ignore" });
			const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
			const deadline = Date.now() + 60_000;
			while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
			assert.ok(fs.existsSync(ready), "the child reached after:chains");
			child.kill("SIGKILL");
			await exited;
			assert.ok(fs.existsSync(journalPath(dir)), "the kill left the journal");
			assert.ok(fs.existsSync(`${markerFile(dir)}.lock`), "the kill left a stale lock");
			assert.equal(readMarkerBytes(dir), undefined, "no marker yet");
			const r = mig(dir, to, { now });
			assert.equal(r.resumed, true);
			assert.deepEqual(exportOf(dir), ref.exportTree);
			assert.equal(fs.existsSync(`${markerFile(dir)}.lock`), false);
		});
	}
});

// ─── M marker last, verify ───────────────────────────────────────────────────

describe("M marker last and verify", () => {
	test("M1 a target that differs from the source at verify: refused, no marker, backup kept, journal removed so the next run restarts and succeeds", () => {
		for (const to of ["sqlite", "doltlite"] as const) {
			const dir = mk();
			buildState(dir, "file", to);
			assert.throws(
				() =>
					mig(dir, to, {
						now,
						checkpoint: (n) => {
							if (n !== "before-verify") return;
							const file = path.join(dir, storeName(to));
							const held = { lockFile: `${file}.lock`, held: () => true, release: () => {} }; // migrate itself holds the real one
							const db = openRW(file, to, held);
							db.run("DELETE FROM ledger_nodes WHERE seq = 1");
							db.close();
						},
					}),
				/verification failed/,
			);
			assert.equal(readMarkerBytes(dir), undefined, `${to}: no marker`);
			assert.equal(fs.existsSync(journalPath(dir)), false, `${to}: journal removed`);
			assert.ok(fs.existsSync(path.join(dir, "migrate-backups")), `${to}: backup kept`);
			assert.equal(mig(dir, to, { now }).resumed, false, `${to}: the rerun starts over`);
			assert.deepEqual(exportOf(dir), reference("file", to).exportTree, `${to}: and ends right`);
		}
	});
	const refusedAtVerify = (dir: string, to: Backend, tamperTarget: () => void, ctx: string): void => {
		assert.throws(() => mig(dir, to, { now, checkpoint: (n) => { if (n === "before-verify") tamperTarget(); } }), /verification failed/, ctx);
		assert.equal(readMarkerBytes(dir)?.includes(`"${to}"`) ?? false, false, `${ctx}: no marker for the target`);
	};
	for (const to of ["sqlite", "doltlite"] as const) {
		test(`M5 verify on ${to}: an expected id that cannot be encoded unchanged never matches what the driver stored for it`, () => {
			const dir = mk();
			seedSql(dir, to, { nodes: [], chains: [], checkpoints: [], coverage: [], sources: [["a\ud800b", '{"id":"x"}']] }, false);
			const snap: Snapshot = { lineFormat: 1, ledgers: { nodes: [], chains: [], coverage: [], checkpoints: [] }, sources: [["a\ud800b", { id: "x" }]], organization: undefined, dropped: { crlf: 0, blank: 0, torn: 0 } };
			assert.equal(sqlDifference(path.join(dir, storeName(to)), to, snap), "sources");
		});
	}
	test("M3 verify is byte-for-byte on a file target: what the normaliser would remove is still a difference", () => {
		const edits: Record<string, (t: string) => string> = {
			"CRLF and a blank line appended": (t) => `${t}\r\n\n`,
			"a blank line appended": (t) => `${t}\n`,
			"a torn tail appended": (t) => `${t}{"x`,
			"CR before the last LF": (t) => t.replace(/\n$/, "\r\n"),
		};
		for (const [name, edit] of Object.entries(edits)) {
			const dir = mk();
			buildState(dir, "sqlite", "file");
			const f = graphFile(dir, "nodes.jsonl");
			refusedAtVerify(dir, "file", () => fs.writeFileSync(f, edit(fs.readFileSync(f, "utf8"))), name);
		}
		const dir = mk();
		seedSql(dir, "sqlite", { ...ROWS, org: undefined }, true);
		refusedAtVerify(dir, "file", () => fs.writeFileSync(graphFile(dir, "source-organization.json"), "{}\n"), "a stray document");
	});
	for (const to of ["sqlite", "doltlite"] as const) {
		test(`M4 verify is byte-for-byte on a ${to} target: rows the reader would normalise, a BLOB, a reformatted record`, () => {
			const statements: Record<string, string> = {
				"a blank row": "INSERT INTO ledger_nodes (seq, line_json) VALUES (999, '')",
				"a trailing CR": "UPDATE ledger_nodes SET line_json = line_json || char(13) WHERE seq = 1",
				"a BLOB with the same bytes": "UPDATE ledger_nodes SET line_json = CAST(line_json AS BLOB) WHERE seq = 1",
				"a source record with the same JSON, other bytes": "UPDATE sources SET record_json = ' ' || record_json WHERE id = 'a'",
				"a document with the same JSON, other bytes": "UPDATE documents SET json = ' ' || json",
			};
			for (const [name, sql] of Object.entries(statements)) {
				const dir = mk();
				buildState(dir, "file", to);
				const file = path.join(dir, storeName(to));
				const held = { lockFile: `${file}.lock`, held: () => true, release: () => {} };
				refusedAtVerify(dir, to, () => {
					const db = openRW(file, to, held);
					db.exec(sql);
					db.close();
				}, name);
			}
		});
	}
	test("M2 the marker is written after the journal is removed, and is the last write", () => {
		const dir = mk();
		buildState(dir, "file", "sqlite");
		const log: string[] = [];
		mig(dir, "sqlite", {
			now,
			checkpoint: (n) => log.push(`${n}|journal=${fs.existsSync(journalPath(dir))}|marker=${fs.existsSync(markerFile(dir))}`),
		});
		const at = (n: string) => log.find((l) => l.startsWith(`${n}|`));
		assert.equal(at("after-verify"), "after-verify|journal=true|marker=false");
		assert.equal(at("after-journal-removed"), "after-journal-removed|journal=false|marker=false");
		assert.equal(at("after-marker"), "after-marker|journal=false|marker=true");
		assert.equal(log.at(-1)?.split("|")[0], "after-marker");
	});
});

// ─── L line_format ───────────────────────────────────────────────────────────

describe("L line_format", () => {
	test("L1 the stamp in format.json is copied to lh_meta.line_format, and back to format.json", () => {
		const dir = mk();
		writeFolder(dir, { ...DIRTY, format: '{"version":1}' });
		mig(dir, "sqlite", { now });
		assert.equal(metaOf(dir, "sqlite", "line_format"), "1");
		mig(dir, "file", { now });
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "graph", "format.json"), "utf8")), { version: 1 });
	});
	test("L2 renderExport copies whatever the snapshot says (a hard-coded constant fails here: the build's constant is 1, so 7 cannot be it)", () => {
		const snap: Snapshot = { lineFormat: 7, ledgers: { nodes: [], chains: [], coverage: [], checkpoints: [] }, sources: [], organization: undefined, dropped: { crlf: 0, blank: 0, torn: 0 } };
		assert.equal(renderExport(snap).get("graph/format.json"), '{\n\t"version": 7\n}\n');
	});
	test("L3 FACT: no valid stamp other than 1 can reach a build whose constant is 1, so a hard-coded value cannot be told apart end to end", () => {
		for (const bad of ['{"version":0}', '{"version":-2}']) {
			const dir = mk();
			writeFolder(dir, { ...DIRTY, format: bad });
			assert.throws(() => mig(dir, "sqlite", { now }), /positive integer/, bad);
			assert.equal(fs.existsSync(path.join(dir, "graph.sqlite")), false);
		}
		console.log("FACT line_format: only 1 is a valid stamp for CURRENT_GRAPH_FORMAT_VERSION=1 (newer refuses, 0 and below make an unopenable store)");
	});
});

// ─── X refusals ──────────────────────────────────────────────────────────────

interface Refusal {
	name: string;
	/** Build the folder; `to` is what migrate is asked for. Returns a cleanup. */
	build(dir: string): { to: Backend; cleanup?: () => void };
	expect: RegExp | (abstract new (...args: never[]) => Error);
	/** The case has no meaning for export. */
	migrateOnly?: boolean;
}
const tamper = (dir: string, b: "sqlite" | "doltlite", sql: string): void => {
	const file = path.join(dir, storeName(b));
	const lock = acquireStoreLock(file);
	const db = openRW(file, b, lock);
	try {
		db.exec(sql);
		db.seal("tamper");
	} finally {
		db.close();
		lock.release();
	}
};
const REFUSALS: Refusal[] = [
	{ name: "marker layout 999", expect: StorageVersionError, build: (d) => (writeFolder(d, DIRTY), fs.writeFileSync(markerFile(d), '{"backend":"file","layout":999}\n'), { to: "sqlite" }) },
	{ name: "corrupt marker", expect: /storage marker/, build: (d) => (writeFolder(d, DIRTY), fs.writeFileSync(markerFile(d), "{"), { to: "sqlite" }) },
	{ name: "format.json 999", expect: StorageVersionError, build: (d) => (writeFolder(d, { ...DIRTY, format: '{"version":999}' }), { to: "sqlite" }) },
	...(["sqlite", "doltlite"] as const).flatMap((b): Refusal[] => [
		{ name: `${b} lh_meta.schema_version 999`, expect: StorageVersionError, build: (d) => (seedSql(d, b, ROWS, true), tamper(d, b, "UPDATE lh_meta SET value = '999' WHERE key = 'schema_version'"), { to: "file" }) },
		{ name: `${b} lh_meta.line_format 999`, expect: StorageVersionError, build: (d) => (seedSql(d, b, ROWS, true), tamper(d, b, "UPDATE lh_meta SET value = '999' WHERE key = 'line_format'"), { to: "file" }) },
		{ name: `${b} unknown table`, expect: /future_thing/, build: (d) => (seedSql(d, b, ROWS, true), tamper(d, b, "CREATE TABLE future_thing (x)"), { to: "file" }) },
		{ name: `${b} unknown documents key`, expect: /documents row/, build: (d) => (seedSql(d, b, ROWS, true), tamper(d, b, "INSERT INTO documents (key, json) VALUES ('future', '{}')"), { to: "file" }) },
		{ name: `${b} corrupt record_json`, expect: /holds invalid JSON/, build: (d) => (seedSql(d, b, ROWS, true), tamper(d, b, "UPDATE sources SET record_json = '{' WHERE id = 'a'"), { to: "file" }) },
		{ name: `${b} store lock held`, expect: StoreLockedError, build: (d) => { seedSql(d, b, ROWS, true); const l = acquireStoreLock(path.join(d, storeName(b))); return { to: "file", cleanup: () => l.release() }; } },
		{ name: `marker names ${b} but the store is missing`, expect: /is missing/, build: (d) => (writeFolder(d, DIRTY), writeMarker(d, b), { to: b === "sqlite" ? "doltlite" : "sqlite" }) },
	]),
	{ name: "target store newer (sqlite)", migrateOnly: true, expect: StorageVersionError, build: (d) => (writeFolder(d, DIRTY), seedSql(d, "sqlite", STALE, false), tamper(d, "sqlite", "UPDATE lh_meta SET value = '999' WHERE key = 'schema_version'"), { to: "sqlite" }) },
	{ name: "target store newer (doltlite)", migrateOnly: true, expect: StorageVersionError, build: (d) => (writeFolder(d, DIRTY), seedSql(d, "doltlite", STALE, false), tamper(d, "doltlite", "UPDATE lh_meta SET value = '999' WHERE key = 'line_format'"), { to: "doltlite" }) },
	{ name: "marker lock held", expect: StoreLockedError, build: (d) => { writeFolder(d, DIRTY); const l = acquireStoreLock(markerFile(d)); return { to: "sqlite", cleanup: () => l.release() }; } },
	{ name: "target store lock held", migrateOnly: true, expect: StoreLockedError, build: (d) => { writeFolder(d, DIRTY); const l = acquireStoreLock(path.join(d, "graph.sqlite")); return { to: "sqlite", cleanup: () => l.release() }; } },
	{ name: "same backend", migrateOnly: true, expect: /nothing to migrate/, build: (d) => (writeFolder(d, DIRTY), { to: "file" }) },
	...['{', "[]", '"x"', "null", ""].map((text): Refusal => ({ name: `corrupt sources.json ${JSON.stringify(text)}`, expect: /sources/, build: (d) => (writeFolder(d, { ...DIRTY, sources: text }), { to: "sqlite" }) })),
	{ name: "invalid UTF-8 in a ledger line", expect: /nodes\.jsonl line 2 is not valid UTF-8/, build: (d) => (writeFolder(d, DIRTY), fs.writeFileSync(graphFile(d, "nodes.jsonl"), bytes('{"id":"n1"}\n{"name":"caf', LATIN1_E9, '"}\n{"id":"n2"}\n')), { to: "sqlite" }) },
	{ name: "invalid UTF-8 in an unterminated last line that is not a cut character", expect: /nodes\.jsonl line 2 is not valid UTF-8/, build: (d) => (writeFolder(d, DIRTY), fs.writeFileSync(graphFile(d, "nodes.jsonl"), bytes('{"id":"n1"}\n{"name":"caf', LATIN1_E9, '"}')), { to: "sqlite" }) },
	...(["sources", "org", "format"] as const).map((k): Refusal => ({ name: `invalid UTF-8 in ${GRAPH_FILES[k]}`, expect: /is not valid UTF-8/, build: (d) => (writeFolder(d, DIRTY), fs.writeFileSync(graphFile(d, GRAPH_FILES[k] as string), bytes('{"name":"caf', LATIN1_E9, '"}')), { to: "sqlite" }) })),
	...(["sqlite", "doltlite"] as const).flatMap((b): Refusal[] => {
		const withRow = (sql: string) => (d: string) => (seedSql(d, b, ROWS, true), tamper(d, b, sql), { to: "file" as Backend });
		const line = (value: string) => `INSERT INTO ledger_nodes (seq, line_json) VALUES (99, ${value})`;
		return [
			{ name: `${b} ledger row with invalid UTF-8`, expect: /ledger_nodes\.line_json row 5 is not valid UTF-8/, build: withRow(line("CAST(x'7bff7d' AS TEXT)")) },
			{ name: `${b} source record with invalid UTF-8`, expect: /sources\.record_json row \d+ is not valid UTF-8/, build: withRow("UPDATE sources SET record_json = CAST(x'7bff7d' AS TEXT) WHERE id = 'a'") },
			{ name: `${b} document with invalid UTF-8`, expect: /documents\.json row 1 is not valid UTF-8/, build: withRow("UPDATE documents SET json = CAST(x'7bff7d' AS TEXT)") },
			{ name: `${b} ledger row holding a newline`, expect: /ledger_nodes\.line_json row 5 holds a line break/, build: withRow(line("'{}' || char(10) || '{}'")) },
			{ name: `${b} ledger row that is a BLOB`, expect: /ledger_nodes\.line_json row 5 holds blob/, build: withRow(line("x'7b7d'")) },
		];
	}),
	...(["sqlite", "doltlite"] as const).map((b): Refusal => ({ name: `lone surrogate in a source id, to ${b}`, migrateOnly: true, expect: /sources\.json sources\.id of "a\\ud800b" holds a lone surrogate/, build: (d) => (writeFolder(d, { ...DIRTY, sources: LONE_SURROGATE_ID }), { to: b }) })),
	{ name: "empty source, sqlite target holds data", migrateOnly: true, expect: /holds no data/, build: (d) => (seedSql(d, "sqlite", STALE, false), { to: "sqlite" }) },
	{ name: "empty sqlite source, file target holds data", migrateOnly: true, expect: /holds no data/, build: (d) => (seedSql(d, "sqlite", { ...STALE, nodes: [] }, true), writeFolder(d, { nodes: '{"id":"keep"}\n', chains: "", sessions: "", coverage: "" }), { to: "file" }) },
	{ name: "corrupt source-organization.json", expect: /not valid JSON/, build: (d) => (writeFolder(d, { ...DIRTY, org: "{" }), { to: "sqlite" }) },
];

describe("X refusals change nothing (bytes, no backup, no journal, no lock)", () => {
	for (const entry of ["migrate", "export"] as const) {
		for (const r of REFUSALS) {
			if (entry === "export" && r.migrateOnly) continue;
			test(`X ${entry}: ${r.name}`, () => {
				const dir = mk();
				const { to, cleanup } = r.build(dir);
				const before = tree(dir);
				let after: Record<string, string>;
				try {
					const call = () => (entry === "migrate" ? mig(dir, to, { now }) : exportStore(dir, path.join(mk(), "out"), { now }));
					assert.throws(call, r.expect instanceof RegExp ? r.expect : (e: unknown) => e instanceof (r.expect as unknown as new () => Error));
					after = tree(dir); // while the test's own lock is still held
				} finally {
					cleanup?.();
				}
				assert.deepEqual(after, before, "nothing in the folder changed");
				assert.equal(fs.existsSync(path.join(dir, "migrate-backups")), false);
				assert.equal(fs.existsSync(journalPath(dir)), false);
				for (const n of fs.readdirSync(dir)) assert.ok(!n.endsWith(".lock") || r.name.includes("lock held"), `lock left: ${n}`);
			});
		}
	}
	for (const entry of ["migrate", "export"] as const) {
		test(`X ${entry}: the marker changing while the locks are taken refuses, and nothing else changes`, () => {
			const dir = mk();
			writeFolder(dir, DIRTY);
			const raced = `${JSON.stringify({ backend: "sqlite", layout: 1 }, null, "\t")}\n`;
			const checkpoint = (n: string): void => {
				if (n === "after-lock") fs.writeFileSync(markerFile(dir), raced);
			};
			const out = path.join(mk(), "out");
			assert.throws(() => (entry === "migrate" ? mig(dir, "sqlite", { now, checkpoint }) : exportStore(dir, out, { now, checkpoint })), /marker changed/);
			assert.equal(fs.readFileSync(markerFile(dir), "utf8"), raced);
			assert.equal(fs.existsSync(path.join(dir, "graph.sqlite")), false);
			assert.equal(fs.existsSync(path.join(dir, "migrate-backups")), false);
			assert.equal(fs.existsSync(journalPath(dir)), false);
			assert.equal(fs.existsSync(out), false);
			assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".lock")), []);
		});
	}
	for (const entry of ["migrate", "export"] as const) {
		test(`X ${entry}: a marker appearing before the locks refuses: the backend comes from the one marker read, so stale data cannot replace a live store`, () => {
			const dir = mk();
			writeFolder(dir, DIRTY);
			const out = path.join(mk(), "out");
			let live = "";
			const checkpoint = (n: string): void => {
				if (n !== "after-refusals") return;
				seedSql(dir, "sqlite", STALE, true);
				live = sha(fs.readFileSync(path.join(dir, "graph.sqlite")));
			};
			assert.throws(() => (entry === "migrate" ? mig(dir, "sqlite", { now, checkpoint }) : exportStore(dir, out, { now, checkpoint })), /marker changed/);
			assert.equal(sha(fs.readFileSync(path.join(dir, "graph.sqlite"))), live, "the live store is untouched");
			assert.equal(fs.existsSync(path.join(dir, "migrate-backups")), false);
			assert.equal(fs.existsSync(out), false);
		});
	}
	test("X a missing data folder refuses both", () => {
		const gone = path.join(root, "nope");
		assert.throws(() => mig(gone, "sqlite"), /does not exist/);
		assert.throws(() => exportStore(gone), /does not exist/);
		assert.equal(fs.existsSync(gone), false);
	});
});

// ─── B backup, export out, CLI ───────────────────────────────────────────────

describe("B backup", () => {
	test("B1 the backup exists before the first entity, with the source and the journal", () => {
		const dir = mk();
		buildState(dir, "sqlite", "file");
		let seen = false;
		mig(dir, "file", {
			now,
			checkpoint: (n) => {
				if (n !== "after-journal") return;
				const j = JSON.parse(fs.readFileSync(journalPath(dir), "utf8"));
				assert.deepEqual(j.done, []);
				assert.ok(fs.existsSync(path.join(j.backupDir, "source", "graph.sqlite")));
				seen = true;
			},
		});
		assert.ok(seen);
	});
	for (const b of ["sqlite", "doltlite"] as const) {
		test(`B2 backup mode equals the source mode (${b}, 0600 stays 0600; 0640 stays 0640)`, () => {
			for (const mode of [0o600, 0o640]) {
				const dir = mk();
				buildState(dir, b, "file");
				fs.chmodSync(path.join(dir, storeName(b)), mode);
				const r = mig(dir, "file", { now });
				assert.equal(fs.statSync(path.join(r.backupDir, "source", storeName(b))).mode & 0o777, mode);
			}
		});
	}
	test("B2b file source: mode of each family file is kept", () => {
		const dir = mk();
		writeFolder(dir, DIRTY);
		fs.chmodSync(path.join(dir, "graph", "nodes.jsonl"), 0o600);
		const r = mig(dir, "sqlite", { now });
		assert.equal(fs.statSync(path.join(r.backupDir, "source", "graph", "nodes.jsonl")).mode & 0o777, 0o600);
		assert.equal(fs.readFileSync(path.join(r.backupDir, "source", "graph", "nodes.jsonl"), "utf8"), DIRTY.nodes, "byte-identical, not normalised");
	});
	test("B3 a pre-existing target is preserved in the backup (SQL by rename, file by copy), then replaced", () => {
		const a = mk();
		buildState(a, "file", "sqlite");
		const oldStore = sha(fs.readFileSync(path.join(a, "graph.sqlite")));
		const ra = mig(a, "sqlite", { now });
		assert.equal(sha(fs.readFileSync(path.join(ra.backupDir, "target", "graph.sqlite"))), oldStore);
		assert.doesNotMatch(JSON.stringify(exportOf(a)), /stale/);

		const b = mk();
		buildState(b, "sqlite", "file");
		const rb = mig(b, "file", { now });
		assert.equal(fs.readFileSync(path.join(rb.backupDir, "target", "graph", "nodes.jsonl"), "utf8"), '{"id":"stale"}\n');
		assert.equal(fs.readFileSync(path.join(rb.backupDir, "target", "graph", "source-organization.json"), "utf8"), '{"stale":true}');
		assert.equal(fs.readFileSync(path.join(b, "graph", "nodes.jsonl"), "utf8").includes("stale"), false);
	});
	test("B4 a stale source-organization.json with no document in the source is removed after the backup", () => {
		const dir = mk();
		seedSql(dir, "sqlite", { ...ROWS, org: undefined }, true);
		writeFolder(dir, { nodes: "", chains: "", sessions: "", coverage: "", org: '{"stale":true}' });
		const r = mig(dir, "file", { now });
		assert.equal(fs.existsSync(path.join(dir, "graph", "source-organization.json")), false);
		assert.ok(fs.existsSync(path.join(r.backupDir, "target", "graph", "source-organization.json")));
	});
	test("B5 a backup dir that already exists errors with nothing changed", () => {
		const dir = mk();
		writeFolder(dir, DIRTY);
		const fixed = () => new Date(Date.UTC(2026, 5, 5));
		fs.mkdirSync(path.join(dir, "migrate-backups", `file-to-sqlite-${fixed().toISOString().replace(/[:.]/g, "-")}`), { recursive: true });
		const before = tree(dir);
		assert.throws(() => mig(dir, "sqlite", { now: fixed }), /EEXIST/);
		assert.deepEqual(tree(dir), before);
	});
});

describe("B export", () => {
	test("B6 export refuses a non-empty out and never overwrites; an empty existing out is fine", () => {
		const dir = mk();
		writeFolder(dir, DIRTY);
		const out = mk();
		fs.writeFileSync(path.join(out, "keep"), "mine");
		assert.throws(() => exportStore(dir, out), /not empty/);
		assert.deepEqual(fs.readdirSync(out), ["keep"]);
		const empty = mk();
		exportStore(dir, empty);
		assert.ok(fs.existsSync(path.join(empty, "graph", "nodes.jsonl")));
		assert.equal(fs.existsSync(path.join(empty, "storage.json")), false, "no marker");
	});
	test("B7 export of a SQL store sorts sources by id and copies positions bytes", () => {
		const dir = mk();
		seedSql(dir, "sqlite", { ...ROWS, sources: [["b", '{"id":"b"}'], ["a", '{"id":"a"}']] }, true);
		fs.mkdirSync(path.join(dir, "graph"), { recursive: true });
		fs.writeFileSync(path.join(dir, "graph", "positions.json"), "P");
		const out = path.join(mk(), "o");
		exportStore(dir, out);
		assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(out, "graph", "sources.json"), "utf8"))), ["a", "b"]);
		assert.equal(fs.readFileSync(path.join(out, "graph", "positions.json"), "utf8"), "P");
	});
});

describe("B CLI", () => {
	const run = (argv: string[]) => {
		const out: string[] = [];
		const err: string[] = [];
		const code = runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
		return { code, out, err };
	};
	test("B8 migrate and export: exit 0, summary printed, files made", () => {
		const dir = mk();
		writeFolder(dir, DIRTY);
		const m = run(["--", "migrate", "--to", "sqlite", "--data-dir", dir]);
		assert.equal(m.code, 0, m.err.join("\n"));
		assert.match(m.out[0] as string, /migrated file -> sqlite/);
		assert.ok(m.out.some((l) => l.includes("1 blank lines dropped") || l.includes("blank lines dropped")));
		const out = path.join(mk(), "x");
		const e = run(["export", "--out", out, "--data-dir", dir]);
		assert.equal(e.code, 0, e.err.join("\n"));
		assert.equal(e.out[0], MIGRATE_TEXT.exported(out));
		assert.ok(fs.existsSync(path.join(out, "graph", "nodes.jsonl")));
	});
	test("B9 `export` with no arguments works (the docs say `pnpm run lh -- export`) and prints the default path", () => {
		const r = run(["--", "export"]);
		assert.equal(r.code, 0, r.err.join("\n"));
		const printed = (r.out[0] as string).replace("exported to ", "");
		assert.ok(fs.existsSync(path.join(printed, "graph", "nodes.jsonl")), printed);
		assert.match(path.basename(printed), /^export-/);
	});
	test("B10 refusals exit 1 with the command's prefix; bad arguments print usage", () => {
		const dir = mk();
		writeFolder(dir, DIRTY);
		fs.writeFileSync(markerFile(dir), '{"backend":"file","layout":999}\n');
		const m = run(["migrate", "--to", "sqlite", "--data-dir", dir]);
		assert.equal(m.code, 1);
		assert.match(m.err[0] as string, /^lh migrate: /);
		const e = run(["export", "--data-dir", dir]);
		assert.equal(e.code, 1);
		assert.match(e.err[0] as string, /^lh export: /);
		assert.deepEqual(run(["migrate"]).err, [MIGRATE_TEXT.usage]);
		assert.deepEqual(run(["migrate", "--to", "mongo"]).err, [MIGRATE_TEXT.usage]);
		assert.deepEqual(run(["export", "--bogus"]).err, [MIGRATE_TEXT.exportUsage]);
		assert.equal(run(["migrate", "--to", "sqlite", "--data-dir", path.join(root, "absent")]).code, 1);
	});
	test("B11 no command or an unknown one prints every usage and exits 1", () => {
		for (const argv of [[], ["bogus"]]) {
			const r = run(argv);
			assert.equal(r.code, 1);
			for (const u of [PURGE_TEXT.usage, MIGRATE_TEXT.usage, MIGRATE_TEXT.exportUsage]) assert.ok(r.err.includes(u), u);
		}
		assert.ok(run(["bogus"]).err.includes(PURGE_TEXT.unknownCommand("bogus")));
	});
	test("B13 `--to doltlite` is refused (this build cannot open a DoltLite folder), from file and from sqlite, and changes nothing", () => {
		for (const from of ["file", "sqlite"] as const) {
			const dir = mk();
			if (from === "file") writeFolder(dir, DIRTY);
			else seedSql(dir, "sqlite", ROWS, true);
			const before = tree(dir);
			const marker = readMarkerBytes(dir);
			const r = run(["migrate", "--to", "doltlite", "--data-dir", dir]);
			assert.equal(r.code, 1);
			assert.equal(r.err[0], `lh migrate: ${MIGRATE_TEXT.doltliteTarget}`);
			assert.deepEqual(tree(dir), before, "source bytes the same, no graph.doltlite, no backup, no journal, no lock");
			assert.equal(readMarkerBytes(dir), marker);
			assert.equal(fs.existsSync(path.join(dir, "graph.doltlite")), false);
		}
		assert.throws(() => migrateBackend(mk(), "doltlite"), /cannot open a DoltLite/, "the API refuses too, before the data folder is even looked at");
	});
	test("B14 DoltLite as a source needs no option: the exit path (--to file and --to sqlite) works through the CLI", () => {
		for (const to of ["file", "sqlite"] as const) {
			const dir = mk();
			seedSql(dir, "doltlite", ROWS, true);
			const r = run(["migrate", "--to", to, "--data-dir", dir]);
			assert.equal(r.code, 0, r.err.join("\n"));
			assert.equal(JSON.parse(readMarkerBytes(dir) as string).backend, to);
		}
	});
	test("B15 --allow-empty-source lets an empty source replace a target that holds data, which stays in the backup", () => {
		const dir = mk();
		seedSql(dir, "sqlite", STALE, false);
		const before = tree(dir);
		const refused = run(["migrate", "--to", "sqlite", "--data-dir", dir]);
		assert.equal(refused.code, 1);
		assert.match(refused.err[0] as string, /--allow-empty-source/);
		assert.deepEqual(tree(dir), before);
		const r = run(["migrate", "--to", "sqlite", "--data-dir", dir, "--allow-empty-source"]);
		assert.equal(r.code, 0, r.err.join("\n"));
		assert.equal(JSON.parse(readMarkerBytes(dir) as string).backend, "sqlite");
		const backups = fs.readdirSync(path.join(dir, "migrate-backups"));
		assert.equal(backups.length, 1);
		const store = path.join(dir, "migrate-backups", backups[0] as string, "target", "graph.sqlite");
		assert.ok(fs.existsSync(store), "the target that held data is in the backup");
		const out = path.join(mk(), "o");
		exportStore(dir, out);
		assert.equal(fs.readFileSync(path.join(out, "graph", "nodes.jsonl"), "utf8"), "");
	});
	test("B16 an empty source over a missing or empty target needs no flag", () => {
		const none = mk();
		fs.mkdirSync(path.join(none, "graph"));
		assert.equal(run(["migrate", "--to", "sqlite", "--data-dir", none]).code, 0);
		const empty = mk();
		seedSql(empty, "sqlite", { ...STALE, nodes: [] }, false);
		assert.equal(run(["migrate", "--to", "sqlite", "--data-dir", empty]).code, 0);
	});
	for (const argv of [["migrate", "--to", "sqlite"], ["export", "--out", "OUT"]]) {
		test(`B17 caf\\xE9 through \`lh ${argv[0]}\`: exit 1, the file and line named, nothing written, the bytes still there`, () => {
			const dir = mk();
			writeFolder(dir, { nodes: "", chains: "", sessions: "", coverage: "" });
			const dirty = bytes('{"id":"n1"}\n{"name":"caf', LATIN1_E9, '"}\n');
			fs.writeFileSync(graphFile(dir, "nodes.jsonl"), dirty);
			const out = path.join(mk(), "out");
			const r = run([...argv.map((a) => (a === "OUT" ? out : a)), "--data-dir", dir]);
			assert.equal(r.code, 1, r.out.join("\n"));
			assert.match(r.err[0] as string, new RegExp(`^lh ${argv[0]}: .*nodes\\.jsonl line 2 is not valid UTF-8`));
			assert.deepEqual(fs.readFileSync(graphFile(dir, "nodes.jsonl")), dirty);
			assert.equal(readMarkerBytes(dir), undefined);
			for (const gone of [path.join(dir, "graph.sqlite"), path.join(dir, "migrate-backups"), out]) assert.equal(fs.existsSync(gone), false, gone);
		});
	}
	test("B18 an invalid SQL row through the CLI refuses both commands, naming the row", () => {
		const dir = mk();
		seedSql(dir, "sqlite", ROWS, true);
		tamper(dir, "sqlite", "INSERT INTO ledger_nodes (seq, line_json) VALUES (99, CAST(x'7bff7d' AS TEXT))");
		for (const argv of [["migrate", "--to", "file"], ["export", "--out", path.join(mk(), "o")]]) {
			const r = run([...argv, "--data-dir", dir]);
			assert.equal(r.code, 1);
			assert.match(r.err[0] as string, /row 5 is not valid UTF-8/);
		}
		assert.equal(JSON.parse(readMarkerBytes(dir) as string).backend, "sqlite");
	});
	for (const [name, tail] of [["a JSON-shaped prefix", bytes('{"name":"caf', [0xc3])], ["a prefix that parses alone", bytes("123", [0xe2, 0x98])]] as const) {
		test(`B19 an append cut inside a character (${name}) is a torn tail: dropped, counted, and a BOM before it survives`, () => {
			const dir = mk();
			const head = bytes('\uFEFF{"id":"n1"}\n');
			writeFolder(dir, { nodes: "", chains: "", sessions: "", coverage: "" });
			fs.writeFileSync(graphFile(dir, "nodes.jsonl"), Buffer.concat([head, tail]));
			const r = run(["migrate", "--to", "sqlite", "--data-dir", dir]);
			assert.equal(r.code, 0, r.err.join("\n"));
			assert.ok(r.out.some((l) => l.includes("1 torn tail lines dropped")), r.out.join("\n"));
			const out = path.join(mk(), "o");
			exportStore(dir, out);
			assert.deepEqual(fs.readFileSync(path.join(out, "graph", "nodes.jsonl")), head);
		});
	}
	test("B20 a lone surrogate in a source id through the CLI: exit 1, the file and id named, nothing written, source bytes unchanged", () => {
		const dir = mk();
		writeFolder(dir, { ...DIRTY, sources: LONE_SURROGATE_ID });
		const before = tree(dir);
		const r = run(["migrate", "--to", "sqlite", "--data-dir", dir]);
		assert.equal(r.code, 1, r.out.join("\n"));
		assert.match(r.err[0] as string, /^lh migrate: .*graph\/sources\.json sources\.id of "a\\ud800b" holds a lone surrogate/);
		assert.deepEqual(tree(dir), before);
		assert.equal(readMarkerBytes(dir), undefined);
		for (const gone of ["graph.sqlite", "migrate-backups", "storage-migrate.journal.json"]) assert.equal(fs.existsSync(path.join(dir, gone)), false, gone);
	});
	test("B21 what can be carried unchanged is not refused: a surrogate pair in an id, a lone-surrogate escape inside a record, and export of a lone-surrogate id", () => {
		const dir = mk();
		const sources = '{"\\ud83d\\ude00":{"name":"x\\ud800y"}}';
		writeFolder(dir, { ...DIRTY, sources });
		const r = run(["migrate", "--to", "sqlite", "--data-dir", dir]);
		assert.equal(r.code, 0, r.err.join("\n"));
		const out = path.join(mk(), "o");
		exportStore(dir, out);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "graph", "sources.json"), "utf8")), { "\ud83d\ude00": { name: "x\ud800y" } });
		assert.ok(fs.readFileSync(path.join(out, "graph", "sources.json"), "utf8").includes("\\ud800"), "the escape stays an escape");

		const lone = mk();
		writeFolder(lone, { ...DIRTY, sources: LONE_SURROGATE_ID });
		const e = path.join(mk(), "o");
		assert.equal(run(["export", "--out", e, "--data-dir", lone]).code, 0, "export keeps it as an escape, so nothing is lost");
		assert.ok(fs.readFileSync(path.join(e, "graph", "sources.json"), "utf8").includes("a\\ud800b"));
	});
	test("B12 every backend name the CLI accepts is one the marker knows", () => {
		assert.deepEqual([...BACKENDS], ["file", "sqlite", "doltlite"]);
	});
});
