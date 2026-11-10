/**
 * Migration runner + graph ladder (architecture 5.4 tests 1-6; test 6, engine parity, runs tests 1-3 on both drivers).
 * MECE by failpoint: ladder shape, partial failure, reopen, every refusal, backup, snapshot, shapes,
 * array-vs-files, released-rung guard. Fake ladders run through fast-check; the real ladder is checked against files.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import fc from "fast-check";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../../src/core/contracts/graph";
import type { SqlDriver } from "../../src/store/sql/driver";
import { openDoltlite } from "../../src/store/sql/drivers/doltlite";
import { openNodeSqlite } from "../../src/store/sql/drivers/node-sqlite";
import { MigrationRefusedError, type MigrateOptions, migrate, schemaDump, schemaHash } from "../../src/store/sql/migrate";
import { graphMigration, graphRungs } from "../../src/store/sql/migrations/graph/index";
import type { Rung } from "../../src/store/sql/rung";

const ROOT = new URL("../..", import.meta.url).pathname;
const MIGRATIONS = "src/store/sql/migrations";
const LOCK = `${MIGRATIONS}/migrations.lock.json`;
const GRAPH_DIR = path.join(ROOT, MIGRATIONS, "graph");

let dir: string;
let n = 0;
before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migrations-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const fresh = () => path.join(dir, `m${n++}.sqlite`);
const open = (file = ":memory:") => openNodeSqlite(file, { busyTimeoutMs: 0 });
/** Test 6: tests 1-3 (the behaviour ones) run once per engine. DoltLite has no ":memory:", so it gets a fresh file. */
/** FACT: after COMMIT DoltLite shows a regenerated CREATE text in sqlite_schema ("t( a INT)" for "t ( a INT )"), so schemaDump differs in spacing between engines (the schema_hash the runner stores, taken inside the rung's transaction, is the same on both). Parity compares with the spacing around parentheses removed. */
const tight = (dump: string) => dump.replace(/\s*([()])\s*/g, "$1");
const engines: [string, (file?: string) => SqlDriver][] = [
	["sqlite", open],
	["doltlite", (file = fresh()) => openDoltlite(file, { busyTimeoutMs: 0 })],
];

// ---- fake ladders ------------------------------------------------------------------------------

const LINE_FORMAT = 3;
const base = { kind: "fake", lhVersion: "test-1", lineFormat: LINE_FORMAT } as const;

/** n dense rungs; rung k adds table t<k>. `failAt` makes that rung leave a partial table behind and throw. */
function fakeRungs(count: number, failAt: number | null = null): Rung[] {
	return Array.from({ length: count }, (_, i) => {
		const k = i + 1;
		return {
			version: k,
			name: `r${k}`,
			up(db: SqlDriver) {
				if (k === 1) db.exec("CREATE TABLE lh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
				db.exec(`CREATE TABLE t${k} (id INTEGER PRIMARY KEY, v TEXT)`);
				if (failAt === k) {
					db.exec(`CREATE TABLE partial_${k} (x)`);
					throw new Error(`rung ${k} boom`);
				}
			},
		};
	});
}

type Spy = SqlDriver & { seals: string[] };
function spy(db: SqlDriver): Spy {
	const seals: string[] = [];
	return { ...db, seals, seal: (m: string) => (seals.push(m), `h${seals.length}`) };
}

/** R5: an upgrade needs a backupPath, so every helper supplies one unless a test says otherwise. */
const backupIn = (f: number) => path.join(dir, `bak-${n++}-v${f}.sqlite`);
const opts = (count: number, failAt: number | null = null, extra: Partial<MigrateOptions> = {}): MigrateOptions => ({ ...base, rungs: fakeRungs(count, failAt), backupPath: backupIn, ...extra });
const hasTable = (db: SqlDriver, name: string) => db.get("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name=?", name) !== undefined;
const metaRows = (db: SqlDriver) => (hasTable(db, "lh_meta") ? db.all<{ key: string; value: string }>("SELECT key, value FROM lh_meta ORDER BY key") : []);
const meta = (db: SqlDriver) => Object.fromEntries(metaRows(db).map((r) => [r.key, r.value]));
const versionOf = (db: SqlDriver) => Number(meta(db).schema_version ?? 0);
const state = (db: SqlDriver) => JSON.stringify({ dump: schemaDump(db), meta: metaRows(db) });
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const rungCount = fc.integer({ min: 1, max: 6 });

describe("fresh DB: version 0 is 'no lh_meta'", () => {
	test("all rungs apply, lh_meta carries every key, one seal per rung", () => {
		fc.assert(
			fc.property(rungCount, (count) => {
				const db = spy(open());
				const r = migrate(db, opts(count));
				assert.deepEqual(r.applied, Array.from({ length: count }, (_, i) => i + 1));
				assert.equal(r.from, 0);
				const m = meta(db);
				assert.equal(m.store_kind, "fake");
				assert.equal(m.schema_version, String(count));
				assert.equal(m.schema_hash, schemaHash(db));
				assert.equal(m.lh_version, "test-1");
				assert.equal(m.engine, "sqlite");
				assert.equal(m.engine_version, db.engineVersion);
				assert.equal(m.revision, "0");
				assert.equal(m.line_format, String(LINE_FORMAT));
				assert.match(m.store_id ?? "", UUID);
				assert.equal(m.store_id, r.storeId);
				assert.deepEqual(
					db.seals,
					Array.from({ length: count }, (_, i) => `migrate fake v${i + 1}: r${i + 1}`),
				);
			}),
			{ numRuns: 30 },
		);
	});

	test("a kind without a line format gets no line_format key", () => {
		const db = open();
		migrate(db, { kind: "seeds", lhVersion: "x", rungs: fakeRungs(1) });
		assert.equal("line_format" in meta(db), false);
	});

	test("a rung 1 that never creates lh_meta fails and rolls back", () => {
		const db = open();
		const rungs: Rung[] = [{ version: 1, name: "bad", up: (d) => d.exec("CREATE TABLE x (a)") }];
		assert.throws(() => migrate(db, { ...base, rungs }), /rung 1 must create it/);
		assert.equal(hasTable(db, "x"), false);
	});
});

describe("failpoint: a rung throws partway", () => {
	test("version stays at N-1, no partial DDL, no seal for it, rerun completes", () => {
		fc.assert(
			fc.property(rungCount, fc.nat(), (count, pick) => {
				const failAt = (pick % count) + 1;
				const file = fresh();
				const first = spy(open(file));
				assert.throws(() => migrate(first, opts(count, failAt)), new RegExp(`rung ${failAt} boom`));
				assert.equal(versionOf(first), failAt - 1);
				assert.equal(hasTable(first, `t${failAt}`), false);
				assert.equal(hasTable(first, `partial_${failAt}`), false);
				assert.equal(first.seals.length, failAt - 1);
				if (failAt === 1) assert.equal(hasTable(first, "lh_meta"), false);
				const idBefore = meta(first).store_id;
				first.close();

				const second = spy(open(file));
				const r = migrate(second, opts(count));
				assert.equal(r.to, count);
				assert.equal(versionOf(second), count);
				assert.deepEqual(r.applied, Array.from({ length: count - (failAt - 1) }, (_, i) => failAt + i));
				if (idBefore) assert.equal(meta(second).store_id, idBefore);
				second.close();
			}),
			{ numRuns: 40 },
		);
	});
});

describe("idempotent reopen", () => {
	test("no change, no seal, store_id stable", () => {
		fc.assert(
			fc.property(rungCount, fc.integer({ min: 1, max: 4 }), (count, reopens) => {
				const file = fresh();
				const db = open(file);
				const id = migrate(db, opts(count)).storeId;
				const before = state(db);
				db.close();
				for (let i = 0; i < reopens; i++) {
					const again = spy(open(file));
					const r = migrate(again, opts(count));
					assert.deepEqual(r.applied, []);
					assert.equal(r.storeId, id);
					assert.equal(again.seals.length, 0);
					assert.equal(state(again), before);
					again.close();
				}
			}),
			{ numRuns: 25 },
		);
	});

	test("upgrading keeps store_id and the earlier rungs' rows", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 3 }), (low, more) => {
				const file = fresh();
				const db = open(file);
				const id = migrate(db, opts(low)).storeId;
				db.run("INSERT INTO t1(v) VALUES ('keep')");
				db.close();
				const up = open(file);
				const r = migrate(up, opts(low + more));
				assert.equal(r.storeId, id);
				assert.deepEqual(r.applied, Array.from({ length: more }, (_, i) => low + 1 + i));
				assert.equal(up.get<{ v: string }>("SELECT v FROM t1")?.v, "keep");
				up.close();
			}),
			{ numRuns: 25 },
		);
	});
});

describe("model: opens with different builds, some crashing", () => {
	type Model = { version: number; storeId: string | null };
	type Real = { file: string };
	class Open implements fc.Command<Model, Real> {
		constructor(
			readonly top: number,
			readonly failAt: number | null,
		) {}
		check = () => true;
		run(m: Model, r: Real) {
			const db = open(r.file);
			try {
				const refuse = this.top < m.version;
				const fails = !refuse && this.failAt !== null && this.failAt > m.version && this.failAt <= this.top;
				let error: unknown;
				try {
					migrate(db, opts(this.top, this.failAt));
				} catch (e) {
					error = e;
				}
				if (refuse) {
					assert.ok(error instanceof MigrationRefusedError && error.reason === "newer-schema", "older build must refuse");
				} else if (fails) {
					assert.ok(error instanceof Error && !(error instanceof MigrationRefusedError), "crashing rung must throw");
					m.version = (this.failAt as number) - 1;
				} else {
					assert.equal(error, undefined);
					m.version = this.top;
				}
				assert.equal(versionOf(db), m.version);
				const id = meta(db).store_id ?? null;
				if (m.version > 0) {
					if (m.storeId === null) m.storeId = id;
					assert.equal(id, m.storeId, "store_id stable");
				} else assert.equal(id, null);
			} finally {
				db.close();
			}
		}
		toString = () => `Open(top=${this.top}, failAt=${this.failAt})`;
	}
	test("DB always matches the model; store_id never changes", () => {
		const cmd = fc.tuple(fc.integer({ min: 1, max: 5 }), fc.option(fc.integer({ min: 1, max: 5 }), { nil: null })).map(([t, f]) => new Open(t, f));
		fc.assert(
			fc.property(fc.commands([cmd], { maxCommands: 12 }), (cmds) => {
				fc.modelRun(() => ({ model: { version: 0, storeId: null }, real: { file: fresh() } }), cmds);
			}),
			{ numRuns: 40 },
		);
	});
});

for (const [engine, open] of engines) describe(`test 3 (${engine}): newer or malformed is refused before any write`, () => {
	/** Store at `low`, then an attempt to upgrade it to `low + 1` after `tamper`. Nothing may change and no backup may be taken. */
	function refused(tamper: (db: SqlDriver) => void, reason: string, low = 1) {
		const file = fresh();
		const db = open(file);
		migrate(db, opts(low));
		tamper(db);
		const before = state(db);
		const backups: number[] = [];
		const sealed = spy(db);
		assert.throws(
			() => migrate(sealed, opts(low + 1, null, { backupPath: (f) => (backups.push(f), `${file}.bak`) })),
			(e: unknown) => e instanceof MigrationRefusedError && e.reason === reason,
		);
		assert.equal(state(db), before);
		assert.equal(sealed.seals.length, 0);
		assert.deepEqual(backups, []);
		assert.equal(hasTable(db, `t${low + 1}`), false);
		db.close();
	}
	const setMeta = (key: string, value: string) => (db: SqlDriver) => void db.run("UPDATE lh_meta SET value = ? WHERE key = ?", value, key);
	const dropMeta = (key: string) => (db: SqlDriver) => void db.run("DELETE FROM lh_meta WHERE key = ?", key);
	const notPositiveInt = fc.oneof(
		fc.constantFrom("", "abc", "NaN", "Infinity", "-1", "0", "1.5", "01", " 2", "2 ", "1e2", "0x2", "99999999999"),
		fc.string().filter((s) => !/^[1-9]\d{0,9}$/.test(s)),
	);

	test("schema_version above the top rung", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 1_000_000 }), (low, d) => {
				// the build tops out at low+1; the store claims more
				refused(setMeta("schema_version", String(low + 1 + d)), "newer-schema", low);
			}),
			{ numRuns: 30 },
		);
	});
	test("line_format above the build's", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 1_000_000 }), (d) => refused(setMeta("line_format", String(LINE_FORMAT + d)), "newer-line-format")),
			{ numRuns: 30 },
		);
	});
	test("malformed schema_version never slips past a > comparison", () => {
		fc.assert(
			fc.property(notPositiveInt, (v) => refused(setMeta("schema_version", v), "malformed-meta")),
			{ numRuns: 60, examples: [["NaN"], ["Infinity"], ["0"], ["1.5"]] },
		);
	});
	test("malformed line_format", () => {
		fc.assert(
			fc.property(notPositiveInt, (v) => refused(setMeta("line_format", v), "malformed-meta")),
			{ numRuns: 60, examples: [["NaN"], ["0"]] },
		);
	});
	test("missing schema_version or line_format row", () => {
		refused(dropMeta("schema_version"), "malformed-meta");
		refused(dropMeta("line_format"), "malformed-meta");
	});
	test("a stored store missing revision or store_id is malformed-meta, never silently accepted (lh-bhc c)", () => {
		refused(dropMeta("revision"), "malformed-meta");
		refused(dropMeta("store_id"), "malformed-meta");
		refused(setMeta("store_id", ""), "malformed-meta");
		fc.assert(
			fc.property(fc.constantFrom("", "abc", "-1", "1.5", "01", " 2", "NaN", "1e2", "0x2"), (v) => refused(setMeta("revision", v), "malformed-meta")),
			{ numRuns: 20 },
		);
	});
	test("a store of another kind", () => {
		refused(setMeta("store_kind", "seeds"), "wrong-kind");
		refused(dropMeta("store_kind"), "wrong-kind");
	});
	test("refusal also covers a store already at the top (read-only open path)", () => {
		refused(setMeta("line_format", String(LINE_FORMAT + 1)), "newer-line-format", 2);
	});
});

describe("test 5: dense, ordered rungs", () => {
	const dense = (xs: number[]) => xs.every((x, i) => x === i + 1);
	test("any other version array is rejected before the DB is touched", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 8 }), { maxLength: 6 }).filter((xs) => !dense(xs) || xs.length === 0),
				(versions) => {
					const db = open();
					const rungs = versions.map((version) => ({ version, name: `v${version}`, up: (d: SqlDriver) => d.exec(`CREATE TABLE z${version} (a)`) }));
					assert.throws(() => migrate(db, { ...base, rungs }));
					assert.equal(db.all("SELECT 1 FROM sqlite_schema").length, 0);
				},
			),
			{ numRuns: 60, examples: [[[]], [[2]], [[0, 1]], [[1, 3]], [[2, 1]], [[1, 1]]] },
		);
	});
	test("non-integer versions are rejected", () => {
		for (const version of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(() => migrate(open(), { ...base, rungs: [{ version, name: "x", up: () => {} }] }));
		}
	});
	test("the graph array is dense from 1, and every file on disk is in it, in order", async () => {
		const files = fs.readdirSync(GRAPH_DIR).filter((f) => /^\d{4}_.+\.ts$/.test(f)).sort();
		assert.deepEqual(
			files,
			graphRungs.map((r) => `${String(r.version).padStart(4, "0")}_${r.name}.ts`),
		);
		for (const [i, file] of files.entries()) {
			const mod = (await import(path.join(GRAPH_DIR, file))) as { default: Rung };
			assert.equal(mod.default, graphRungs[i], `${file} is the array element`);
		}
		assert.ok(graphRungs.every((r, i) => r.version === i + 1));
	});
});

describe("R5: backup before upgrade", () => {
	const lhOpts = (count: number, extra: Partial<MigrateOptions>) => opts(count, null, extra);

	test("sqlite upgrade leaves a VACUUM INTO copy at the version being left; fresh and reopen take none", () => {
		fc.assert(
			fc.property(fc.integer({ min: 2, max: 5 }), fc.nat(), (top, pick) => {
				const from = (pick % (top - 1)) + 1;
				const file = fresh();
				const bak = `${file}.bak-v${from}`;
				const calls: number[] = [];
				const backupPath = (f: number) => (calls.push(f), bak);

				const first = open(file);
				migrate(first, lhOpts(from, { backupPath })); // fresh: from 0
				assert.deepEqual(calls, []);
				first.run("INSERT INTO t1(v) VALUES ('x')");
				migrate(first, lhOpts(from, { backupPath })); // reopen at top
				assert.deepEqual(calls, []);
				first.close();

				const up = open(file);
				migrate(up, lhOpts(top, { backupPath }));
				assert.deepEqual(calls, [from]);
				up.close();

				const copy = open(bak);
				assert.equal(versionOf(copy), from);
				assert.equal(copy.get<{ v: string }>("SELECT v FROM t1")?.v, "x");
				assert.equal(hasTable(copy, `t${from + 1}`), false);
				copy.close();
			}),
			{ numRuns: 20 },
		);
	});

	test("an upgrade of an existing sqlite store with NO backupPath throws before any write; fresh create and reopen need none; DoltLite needs none (lh-bhc f)", () => {
		fc.assert(
			fc.property(fc.integer({ min: 2, max: 5 }), fc.nat(), (top, pick) => {
				const from = (pick % (top - 1)) + 1;
				const db = open(fresh());
				migrate(db, opts(from, null, { backupPath: undefined })); // fresh: from 0, no backup needed
				migrate(db, opts(from, null, { backupPath: undefined })); // reopen at top
				const before = state(db);
				const sealed = spy(db);
				assert.throws(() => migrate(sealed, opts(top, null, { backupPath: undefined })), /needs a backupPath/);
				assert.equal(state(db), before, "nothing written");
				assert.equal(sealed.seals.length, 0);
				assert.equal(hasTable(db, `t${from + 1}`), false);
				const dolt = { ...db, engine: "doltlite" as const, head: () => "h" };
				migrate(dolt, opts(top, null, { backupPath: undefined })); // history is the backup there
				assert.equal(versionOf(db), top);
				db.close();
			}),
			{ numRuns: 20 },
		);
	});

	test("a backup that cannot be taken aborts the upgrade untouched", () => {
		const file = fresh();
		const db = open(file);
		migrate(db, lhOpts(1, {}));
		const dest = `${file}.bak`;
		fs.writeFileSync(dest, "occupied");
		const before = state(db);
		assert.throws(() => migrate(db, lhOpts(2, { backupPath: () => dest })));
		assert.equal(state(db), before);
		assert.equal(hasTable(db, "t2"), false);
		db.close();
	});

	test("DoltLite records HEAD in the log and takes no file copy", () => {
		const file = fresh();
		const db = open(file);
		migrate(db, lhOpts(1, {}));
		const dolt = { ...db, engine: "doltlite" as const, head: () => "deadbeef" };
		const log: string[] = [];
		let backups = 0;
		migrate(dolt, lhOpts(2, { log: (m) => log.push(m), backupPath: () => (backups++, `${file}.bak`) }));
		assert.equal(backups, 0);
		assert.equal(log.length, 1);
		assert.match(log[0] as string, /deadbeef/);
		assert.equal(versionOf(db), 2);
		db.close();
	});

	test("the sqlite backup gets the store's mode, not the umask's (lh-tit)", () => {
		const file = fresh();
		const db = open(file);
		migrate(db, graphOpts(1));
		db.close();
		fs.chmodSync(file, 0o600);
		const bak = `${file}.bak`;
		const up = open(file);
		const umask = process.umask(0o277); // strips owner bits from 0600: only the fchmod keeps the store's mode
		try {
			migrate(up, graphOpts(graphRungs.length, { backupPath: () => bak }));
		} finally {
			process.umask(umask);
		}
		up.close();
		assert.equal(fs.statSync(bak).mode & 0o777, 0o600);
	});

	test("an existing backup file is never overwritten: the upgrade refuses and the store stays at the old rung (lh-tit)", () => {
		const file = fresh();
		const db = open(file);
		migrate(db, graphOpts(1));
		const bak = `${file}.bak`;
		fs.writeFileSync(bak, "occupied");
		assert.throws(() => migrate(db, graphOpts(graphRungs.length, { backupPath: () => bak })), /already exists/);
		assert.equal(fs.readFileSync(bak, "utf8"), "occupied");
		assert.equal(versionOf(db), 1);
		db.close();
	});
});

// ---- real graph ladder ---------------------------------------------------------------------------

const graphOpts = (count = graphRungs.length, extra: Partial<MigrateOptions> = {}): MigrateOptions => ({ ...graphMigration, rungs: graphRungs.slice(0, count), lhVersion: "test", backupPath: backupIn, ...extra });

for (const [engine, open] of engines) describe(`test 1 (${engine}): fresh equals snapshot.sql`, () => {
	const snapshot = fs.readFileSync(path.join(GRAPH_DIR, "snapshot.sql"), "utf8");
	test("all graph rungs on an empty DB dump to the checked-in snapshot", () => {
		const db = open();
		migrate(db, graphOpts());
		assert.equal(tight(schemaDump(db)), tight(snapshot));
		// DoltLite regenerates the CREATE text of tables committed by an earlier rung (see the FACT above), and the runner hashes inside the last rung's
		// transaction: with two or more rungs its hash is not sha(snapshot). It is informational (written, never checked at open), so only its shape is asserted there.
		if (engine === "sqlite") assert.equal(meta(db).schema_hash, sha(snapshot));
		else assert.match(meta(db).schema_hash!, /^[0-9a-f]{64}$/);
		assert.equal(meta(db).line_format, String(CURRENT_GRAPH_FORMAT_VERSION));
		assert.equal(meta(db).store_kind, "graph");
	});
	test("the snapshot is the six rung-1 graph tables plus lh_meta, plus rung 2's ledger_reviews and ledger_review_remaps", () => {
		assert.deepEqual(
			snapshot.split("\n").filter(Boolean).map((l) => /CREATE TABLE (\w+)/.exec(l)?.[1]),
			["documents", "ledger_chains", "ledger_checkpoints", "ledger_coverage", "ledger_nodes", "ledger_review_remaps", "ledger_reviews", "lh_meta", "sources"],
		);
	});
});

/** One row per table, as test 2 needs. lh_meta gets a store of version `v`. */
function seedRows(db: SqlDriver, kind: string, v: number, lineFormat: number | null) {
	const tables = db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").map((t) => t.name);
	for (const t of tables) {
		if (t === "lh_meta") {
			const rows: [string, string][] = [["store_kind", kind], ["schema_version", String(v)], ["store_id", "fixed-id"], ["revision", "7"], ["custom", "keep"]];
			if (lineFormat !== null) rows.push(["line_format", String(lineFormat)]);
			for (const [k, val] of rows) db.run("INSERT INTO lh_meta(key, value) VALUES (?, ?)", k, val);
			continue;
		}
		const cols = db.all<{ name: string; type: string; pk: number }>(`PRAGMA table_info(${t})`).filter((c) => !(c.pk && c.type === "INTEGER"));
		if (cols.length === 0) db.exec(`INSERT INTO ${t} DEFAULT VALUES`);
		else db.run(`INSERT INTO ${t}(${cols.map((c) => c.name).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...cols.map((c) => `row-${t}-${c.name}`));
	}
	return tables;
}
const rowsOf = (db: SqlDriver, t: string) => db.all<Record<string, unknown>>(`SELECT * FROM ${t} ORDER BY 1`);

describe("test 2: every recorded shape migrates and keeps its rows", () => {
	const top = graphRungs.length;
	test("shapes/ holds exactly v1..vTop", () => {
		assert.deepEqual(
			fs.readdirSync(path.join(GRAPH_DIR, "shapes")).sort(),
			Array.from({ length: top }, (_, i) => `v${i + 1}.sql`).sort(),
		);
	});
	for (const [engine, open] of engines) test(`each recorded shape is what the rungs up to it really produce (${engine})`, () => {
		for (let v = 1; v <= top; v++) {
			const db = open();
			migrate(db, graphOpts(v));
			assert.equal(tight(fs.readFileSync(path.join(GRAPH_DIR, "shapes", `v${v}.sql`), "utf8")), tight(schemaDump(db)), `v${v}.sql`);
		}
	});
	for (const [engine, open] of engines) test(`graph: each shape, one row per table, migrates to the top with rows intact (${engine})`, () => {
		for (let v = 1; v <= top; v++) {
			const db = open();
			db.exec(fs.readFileSync(path.join(GRAPH_DIR, "shapes", `v${v}.sql`), "utf8"));
			const tables = seedRows(db, "graph", v, CURRENT_GRAPH_FORMAT_VERSION);
			const before = Object.fromEntries(tables.map((t) => [t, rowsOf(db, t)]));
			migrate(db, graphOpts());
			assert.equal(versionOf(db), top);
			for (const t of tables.filter((x) => x !== "lh_meta")) assert.deepEqual(rowsOf(db, t).slice(0, before[t]?.length), before[t], t);
			assert.equal(meta(db).store_id, "fixed-id");
			assert.equal(meta(db).custom, "keep");
			assert.equal(meta(db).revision, "7");
			assert.equal(tight(schemaDump(db)), tight(fs.readFileSync(path.join(GRAPH_DIR, "snapshot.sql"), "utf8")));
		}
	});
	for (const [engine, open] of engines) test(`graph v1 -> v2 adds an empty ledger_reviews and keeps every v1 row (${engine})`, () => {
		const db = open();
		db.exec(fs.readFileSync(path.join(GRAPH_DIR, "shapes", "v1.sql"), "utf8"));
		const tables = seedRows(db, "graph", 1, CURRENT_GRAPH_FORMAT_VERSION);
		assert.ok(!tables.includes("ledger_reviews"), "v1 has no review ledger");
		const before = Object.fromEntries(tables.map((t) => [t, rowsOf(db, t)]));
		migrate(db, graphOpts(2));
		assert.equal(versionOf(db), 2);
		assert.deepEqual(db.all("SELECT * FROM ledger_reviews"), []);
		assert.deepEqual(db.all<{ name: string }>("SELECT name FROM pragma_table_info('ledger_reviews') ORDER BY cid").map((c) => c.name), ["seq", "line_json"]);
		for (const t of tables.filter((x) => x !== "lh_meta")) assert.deepEqual(rowsOf(db, t), before[t], t);
	});
	test("fake ladders: shape recorded at any v migrates to any higher top", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 3 }), (v, more) => {
				const src = open();
				migrate(src, opts(v));
				const shape = schemaDump(src);
				const db = open();
				db.exec(shape);
				const tables = seedRows(db, "fake", v, LINE_FORMAT);
				const before = Object.fromEntries(tables.map((t) => [t, rowsOf(db, t)]));
				const r = migrate(db, opts(v + more));
				assert.deepEqual(r.applied, Array.from({ length: more }, (_, i) => v + 1 + i));
				for (const t of tables.filter((x) => x !== "lh_meta")) assert.deepEqual(rowsOf(db, t), before[t]);
				assert.equal(meta(db).store_id, "fixed-id");
				assert.equal(versionOf(db), v + more);
			}),
			{ numRuns: 40 },
		);
	});
});

// ---- test 4: released rungs --------------------------------------------------------------------

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
const commit = (cwd: string, msg: string) => git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", msg);
const ORIGIN_MAIN = "refs/remotes/origin/main";

/** Fails (throws) when origin/main cannot be resolved: a guard that skips here protects nothing (CI checks out at depth 1). */
function ensureOriginMain(repo: string) {
	const resolves = () => {
		try {
			git(repo, "rev-parse", "--verify", "--quiet", `${ORIGIN_MAIN}^{commit}`);
			return true;
		} catch {
			return false;
		}
	};
	if (resolves()) return;
	try {
		git(repo, "fetch", "--depth=1", "origin", `main:${ORIGIN_MAIN}`);
	} catch {
		// fall through to the assertion below
	}
	if (!resolves()) throw new Error("origin/main cannot be resolved, even after `git fetch --depth=1 origin main`; the released-rung guard cannot run");
}

/** Lock as released: read from origin/main, never the working copy. `{}` only when the ref exists and the file is not in it. */
function releasedLock(repo: string): Record<string, string> {
	ensureOriginMain(repo);
	try {
		git(repo, "cat-file", "-e", `${ORIGIN_MAIN}:${LOCK}`);
	} catch {
		return {};
	}
	return JSON.parse(git(repo, "show", `${ORIGIN_MAIN}:${LOCK}`)) as Record<string, string>;
}

/** Rung files on disk keyed "<kind>/<file>" -> sha256. */
function rungHashes(repo: string): Record<string, string> {
	const root = path.join(repo, MIGRATIONS);
	const out: Record<string, string> = {};
	for (const kind of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
		for (const f of fs.readdirSync(path.join(root, kind.name)).filter((x) => /^\d{4}_.+\.ts$/.test(x))) {
			out[`${kind.name}/${f}`] = sha(fs.readFileSync(path.join(root, kind.name, f)));
		}
	}
	return out;
}

function releasedViolations(repo: string): string[] {
	const disk = rungHashes(repo);
	return Object.entries(releasedLock(repo)).flatMap(([key, hash]) => (!(key in disk) ? [`${key}: released rung deleted`] : disk[key] !== hash ? [`${key}: released rung edited`] : []));
}

function lockMismatches(repo: string): string[] {
	const lock = JSON.parse(fs.readFileSync(path.join(repo, LOCK), "utf8")) as Record<string, string>;
	const disk = rungHashes(repo);
	return [...new Set([...Object.keys(lock), ...Object.keys(disk)])].filter((k) => lock[k] !== disk[k]).map((k) => `${k}: lock ${lock[k] ?? "missing"}, disk ${disk[k] ?? "missing"}`);
}

describe("test 4: released rungs are unchanged", () => {
	test("this repo: rungs match origin/main's lock, and the working lock matches the files", () => {
		assert.deepEqual(releasedViolations(ROOT), []);
		assert.deepEqual(lockMismatches(ROOT), []);
	});

	/** A throwaway repo whose origin/main holds one released rung. Never touches this repo's refs. */
	function makeRepo(withLock: boolean) {
		const repo = fs.mkdtempSync(path.join(dir, "repo-"));
		const rungDir = path.join(repo, MIGRATIONS, "graph");
		fs.mkdirSync(rungDir, { recursive: true });
		fs.writeFileSync(path.join(rungDir, "0001_init.ts"), "export default { version: 1 };\n");
		const writeLock = () => fs.writeFileSync(path.join(repo, LOCK), `${JSON.stringify(rungHashes(repo), null, "\t")}\n`);
		if (withLock) writeLock();
		git(repo, "init", "-q", "-b", "main");
		git(repo, "add", "-A");
		commit(repo, "released");
		return { repo, rungDir, writeLock, rung1: path.join(rungDir, "0001_init.ts") };
	}

	test("unchanged released rung passes", () => {
		const r = makeRepo(true);
		git(r.repo, "update-ref", ORIGIN_MAIN, "HEAD");
		assert.deepEqual(releasedViolations(r.repo), []);
		assert.deepEqual(lockMismatches(r.repo), []);
	});

	test("editing a released rung fails even after re-hashing the working lock", () => {
		const r = makeRepo(true);
		git(r.repo, "update-ref", ORIGIN_MAIN, "HEAD");
		const original = fs.readFileSync(r.rung1, "utf8");
		fc.assert(
			fc.property(
				fc.string({ minLength: 1 }).filter((s) => s !== original),
				(content) => {
					fs.writeFileSync(r.rung1, content);
					r.writeLock(); // the cheat: lock now agrees with the edited file
					assert.deepEqual(lockMismatches(r.repo), [], "self-comparison is blind to the edit");
					assert.deepEqual(releasedViolations(r.repo), ["graph/0001_init.ts: released rung edited"]);
				},
			),
			{ numRuns: 15 },
		);
	});

	test("deleting a released rung fails", () => {
		const r = makeRepo(true);
		git(r.repo, "update-ref", ORIGIN_MAIN, "HEAD");
		fs.rmSync(r.rung1);
		r.writeLock();
		assert.deepEqual(releasedViolations(r.repo), ["graph/0001_init.ts: released rung deleted"]);
	});

	test("a new rung is not released, but a new rung without a lock entry fails the lock check", () => {
		const r = makeRepo(true);
		git(r.repo, "update-ref", ORIGIN_MAIN, "HEAD");
		fs.writeFileSync(path.join(r.rungDir, "0002_more.ts"), "export default { version: 2 };\n");
		assert.deepEqual(releasedViolations(r.repo), []);
		assert.equal(lockMismatches(r.repo).length, 1);
		r.writeLock();
		assert.deepEqual(lockMismatches(r.repo), []);
	});

	test("origin/main exists but has no lock yet: nothing is released", () => {
		const r = makeRepo(false);
		git(r.repo, "update-ref", ORIGIN_MAIN, "HEAD");
		fs.writeFileSync(r.rung1, "export default { edited: true };\n");
		assert.deepEqual(releasedViolations(r.repo), []);
	});

	test("origin/main missing and unfetchable: the guard FAILS, never skips", () => {
		const r = makeRepo(true);
		assert.throws(() => releasedViolations(r.repo), /origin\/main cannot be resolved/);
	});

	test("depth-1 checkout without origin/main: the test fetches it itself, then still catches the edit", () => {
		const origin = makeRepo(true);
		git(origin.repo, "branch", "feature");
		git(origin.repo, "checkout", "-q", "feature");
		fs.writeFileSync(path.join(origin.repo, "pr.txt"), "pr");
		git(origin.repo, "add", "-A");
		commit(origin.repo, "pr");
		git(origin.repo, "checkout", "-q", "main");
		const clone = path.join(dir, `clone-${n++}`);
		git(dir, "clone", "-q", "--depth=1", "--single-branch", "--branch", "feature", `file://${origin.repo}`, clone);
		assert.throws(() => git(clone, "rev-parse", "--verify", "--quiet", ORIGIN_MAIN), "no origin/main in the shallow clone");
		fs.writeFileSync(path.join(clone, MIGRATIONS, "graph", "0001_init.ts"), "export default { sneaky: true };\n");
		fs.writeFileSync(path.join(clone, LOCK), `${JSON.stringify(rungHashes(clone), null, "\t")}\n`);
		assert.deepEqual(releasedViolations(clone), ["graph/0001_init.ts: released rung edited"]);
		assert.ok(git(clone, "rev-parse", ORIGIN_MAIN).trim(), "ref was fetched into the clone");
	});
});

describe("test 6: engine parity", () => {
	test("the real ladder yields the same dump (up to spacing) and meta (but engine, version, id, hash) on sqlite and DoltLite, at every rung", () => {
		for (let v = 1; v <= graphRungs.length; v++) {
			const [a, b] = [open(), openDoltlite(fresh(), { busyTimeoutMs: 0 })];
			migrate(a, graphOpts(v));
			migrate(b, graphOpts(v));
			assert.equal(tight(schemaDump(b)), tight(schemaDump(a)), `v${v}`);
			const strip = (db: SqlDriver) => Object.fromEntries(Object.entries(meta(db)).filter(([k]) => !["engine", "engine_version", "store_id", "schema_hash"].includes(k)));
			assert.deepEqual(strip(b), strip(a), `v${v}`);
			assert.equal(meta(a).engine, "sqlite");
			assert.equal(meta(b).engine, "doltlite");
		}
	});
	test("DoltLite seals one commit per rung, labelled as the runner says", () => {
		const db = openDoltlite(fresh(), { busyTimeoutMs: 0 });
		migrate(db, graphOpts());
		const log = db.all<{ message: string }>("SELECT message FROM dolt_log").map((r) => r.message);
		for (const rung of graphRungs) assert.ok(log.includes(`migrate graph v${rung.version}: ${rung.name}`), `v${rung.version}`);
	});
});
