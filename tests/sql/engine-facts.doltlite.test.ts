/**
 * Engine facts for the DoltLite driver (D1, CB3). Twins every fact of engine-facts.sqlite.test.ts that is not
 * sqlite-specific (same F numbers), then adds the DoltLite facts: seal/head, working-set durability, recover-at-open,
 * file@hash readers, VACUUM INTO, growth per commit, dolt_diff.
 * The pin in package.json optionalDependencies must equal the version on the next line (scripts/check-version-pins.ts):
 *
 * DoltLite version under test: 0.51.9
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { comparePins } from "../../scripts/check-version-pins";
import type { SqlDriver } from "../../src/store/sql/driver";
import { openDoltlite, openReaderAt, RECOVER_MESSAGE } from "../../src/store/sql/drivers/doltlite";
import { acquireStoreLock, lockFileFor, type StoreLock } from "../../src/store/sql/lock";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nodeRequire = createRequire(import.meta.url);

let dir: string;
let n = 0;
before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-doltlite-facts-"));
});
const locks = new Map<string, StoreLock>();
after(() => {
	for (const l of locks.values()) l.release();
	fs.rmSync(dir, { recursive: true, force: true });
});
const fresh = () => path.join(dir, `s${n++}.db`);
const open = (file = fresh()) => openDoltlite(file, { busyTimeoutMs: 0 });
/** A REAL store lock (one per file, reused while held): a plain object could never show a lock is held. */
const lockOf = (file: string): StoreLock => {
	const known = locks.get(file);
	if (known?.held()) return known;
	const lock = acquireStoreLock(file);
	locks.set(file, lock);
	return lock;
};
const LEDGER = "CREATE TABLE ledger (seq INTEGER PRIMARY KEY, line_json TEXT NOT NULL)";
const count = (db: SqlDriver, table = "ledger") => db.get<{ c: number }>(`SELECT count(*) AS c FROM ${table}`)?.c;
const lines = (db: SqlDriver) => db.all<{ line_json: string }>("SELECT line_json FROM ledger ORDER BY seq").map((r) => r.line_json);
const commits = (db: SqlDriver) => db.all<{ commit_hash: string; message: string }>("SELECT commit_hash, message FROM dolt_log").map((r) => ({ ...r }));
const dirtyTables = (db: SqlDriver) => count(db, "dolt_status");
const HASH = /^[0-9a-f]{40}$/;
/** A store with a committed ledger table (seq 1) and, when `dirty`, one row left in the working set. Closed again. */
function store(dirty: boolean): { file: string; head: string; commitCount: number } {
	const file = fresh();
	const db = open(file);
	db.exec(LEDGER);
	db.run("INSERT INTO ledger(line_json) VALUES ('base')");
	const head = db.seal("base") as string;
	if (dirty) db.run("INSERT INTO ledger(line_json) VALUES ('leftover')");
	const commitCount = commits(db).length;
	db.close();
	return { file, head, commitCount };
}
const peek = (file: string) => {
	const r = openDoltlite(file, { readOnly: true });
	try {
		return { dirty: dirtyTables(r) as number, log: commits(r), lines: lines(r) };
	} finally {
		r.close();
	}
};

describe("engine facts: DoltLite", () => {
	test("F1 the addon loads under ELECTRON_RUN_AS_NODE with the shipped Electron binary", () => {
		const electron = nodeRequire("electron") as string;
		assert.ok(fs.existsSync(electron), `Electron binary missing at ${electron}`);
		const addon = nodeRequire.resolve("@dolthub/doltlite");
		const script = `const {DatabaseSync}=require(${JSON.stringify(addon)});const d=new DatabaseSync(":memory:");d.exec("CREATE TABLE t(x)");d.exec("INSERT INTO t VALUES (41)");console.log(JSON.stringify({e:process.versions.electron,y:d.prepare("SELECT x+1 AS y FROM t").get().y,arch:process.arch,platform:process.platform}))`;
		const out = execFileSync(electron, ["-e", script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 60_000 });
		const parsed = JSON.parse(out.trim().split("\n").at(-1) as string) as { e: string; y: number };
		assert.ok(parsed.e, "ran inside Electron, not plain node");
		assert.equal(parsed.y, 42);
		console.log(`FACT F1: addon loads under Electron ${parsed.e} (${out.trim().split("\n").at(-1)})`);
	});

	test("F2 reports engine and version (the package's, not doltVersion()); seal and head are commit hashes", () => {
		const pinned = (JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { optionalDependencies: Record<string, string> }).optionalDependencies["@dolthub/doltlite"];
		const db = open();
		assert.equal(db.engine, "doltlite");
		assert.equal(db.engineVersion, pinned);
		db.exec(LEDGER);
		const h = db.seal("x");
		assert.match(h as string, HASH);
		assert.equal(db.head(), h);
		db.close();
		// TRAP: the addon's own version string is not a version.
		const raw = new (nodeRequire("@dolthub/doltlite").DatabaseSync)(":memory:");
		assert.equal(raw.doltVersion(), "doltlite-amalgamation");
		raw.close();
	});

	test("F3 file stores report journal_mode=wal and synchronous=FULL (DoltLite's own, no pragma needed)", () => {
		const raw = new (nodeRequire("@dolthub/doltlite").DatabaseSync)(fresh());
		assert.equal(raw.prepare("PRAGMA journal_mode").get().journal_mode, "wal", "before any pragma");
		assert.equal(raw.prepare("PRAGMA synchronous").get().synchronous, 2);
		raw.close();
		const db = open();
		assert.equal(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode, "wal");
		assert.equal(db.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous, 2);
		assert.equal(db.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout, 0);
		assert.equal(openDoltlite(fresh()).get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout, 5000, "default busy timeout");
		db.close();
	});

	test("F4 transaction commits its writes and returns fn's value", () => {
		const db = open();
		db.exec(LEDGER);
		assert.equal(
			db.transaction(() => {
				db.run("INSERT INTO ledger(line_json) VALUES (?)", "a");
				return 7;
			}),
			7,
		);
		assert.equal(count(db), 1);
		db.close();
	});

	test("F5 transaction rolls back rows and DDL when fn throws, and rethrows the same error", () => {
		const db = open();
		db.exec(LEDGER);
		const boom = new Error("boom");
		assert.throws(
			() =>
				db.transaction(() => {
					db.run("INSERT INTO ledger(line_json) VALUES ('x')");
					db.exec("CREATE TABLE extra (a)");
					throw boom;
				}),
			(e) => e === boom,
		);
		assert.equal(count(db), 0);
		assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name='extra'"), undefined);
		db.run("INSERT INTO ledger(line_json) VALUES ('after')");
		assert.equal(count(db), 1);
		db.close();
	});

	test("F5b a failing ROLLBACK never masks the error fn threw", () => {
		const db = open();
		const boom = new Error("boom");
		assert.throws(
			() =>
				db.transaction(() => {
					db.close();
					throw boom;
				}),
			(e) => e === boom,
		);
	});

	test("F6 BEGIN IMMEDIATE: a second writer is refused with the exact text 'database is locked' while a transaction is open; a reader is not", () => {
		const file = fresh();
		const a = open(file);
		const b = open(file);
		a.exec(LEDGER);
		a.seal("ledger");
		let text = "";
		a.transaction(() => {
			a.run("INSERT INTO ledger(line_json) VALUES ('held')");
			try {
				b.transaction(() => undefined);
			} catch (e) {
				text = (e as Error).message;
			}
			assert.equal(count(b), 0, "reader sees the last committed state, not pending writes");
			let bare = "";
			try {
				b.run("INSERT INTO ledger(line_json) VALUES ('x')");
			} catch (e) {
				bare = (e as Error).message;
			}
			console.log(`FACT busy error text of a bare write: ${JSON.stringify(bare)}`);
			assert.equal(bare, "run: database is locked", "the addon prefixes the failing method on prepared statements");
		});
		console.log(`FACT busy error text: ${JSON.stringify(text)}`);
		assert.equal(text, "database is locked");
		assert.equal(count(b), 1);
		b.transaction(() => undefined);
		a.close();
		b.close();
	});

	test("F6b the busy timeout is honoured: a second writer waits about that long, then gets the busy error", () => {
		const file = fresh();
		const a = open(file);
		a.exec(LEDGER);
		a.seal("ledger");
		const script = path.join(dir, "busy-child.mts");
		fs.writeFileSync(
			script,
			`import {openDoltlite} from ${JSON.stringify(path.join(repo, "src/store/sql/drivers/doltlite.ts"))};
const db=openDoltlite(process.argv[2],{busyTimeoutMs:1500});const t=Date.now();
db.transaction(()=>db.run("INSERT INTO ledger(line_json) VALUES ('child')"));console.log(JSON.stringify({waited:Date.now()-t}));db.close();`,
		);
		a.exec("BEGIN IMMEDIATE");
		const started = Date.now();
		const child = spawnSync(process.execPath, ["--import", "tsx", script, file], { cwd: repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_ENV: "test" } });
				assert.notEqual(child.status, 0);
		assert.match(child.stderr, /database is locked/);
		assert.ok(Date.now() - started >= 1200, "child waited for its busy timeout before giving up");
		a.exec("ROLLBACK");
		a.close();
	});

	test("F7 nested transaction joins the outer one: inner writes roll back with the outer", () => {
		const db = open();
		db.exec(LEDGER);
		db.transaction(() => {
			db.transaction(() => db.run("INSERT INTO ledger(line_json) VALUES ('inner')"));
			db.run("INSERT INTO ledger(line_json) VALUES ('outer')");
		});
		assert.equal(count(db), 2);
		assert.throws(() =>
			db.transaction(() => {
				db.transaction(() => db.run("INSERT INTO ledger(line_json) VALUES ('lost')"));
				throw new Error("outer fails");
			}),
		);
		assert.equal(count(db), 2);
		db.close();
	});

	test("F8 a caught inner throw dooms the outer transaction: it rolls back and throws", () => {
		const db = open();
		db.exec(LEDGER);
		assert.throws(
			() =>
				db.transaction(() => {
					db.run("INSERT INTO ledger(line_json) VALUES ('kept?')");
					try {
						db.transaction(() => {
							throw new Error("inner");
						});
					} catch {
						// swallowed on purpose
					}
				}),
			/nested transaction threw/,
		);
		assert.equal(count(db), 0);
		db.transaction(() => db.run("INSERT INTO ledger(line_json) VALUES ('next')"));
		assert.equal(count(db), 1);
		db.close();
	});

	test("F9 an async callback (returned thenable) rolls back and throws, outer and nested", () => {
		const db = open();
		db.exec(LEDGER);
		assert.throws(() => db.transaction((() => Promise.resolve(db.run("INSERT INTO ledger(line_json) VALUES ('p')"))) as () => unknown), /synchronous/);
		assert.equal(count(db), 0);
		assert.throws(() => db.transaction(() => db.transaction((() => Promise.resolve()) as () => unknown)), /synchronous/);
		assert.equal(count(db), 0);
		db.close();
	});

	test("F10 run().changes counts affected rows; a no-op reports 0", () => {
		const db = open();
		db.exec(LEDGER);
		assert.equal(db.run("INSERT INTO ledger(line_json) VALUES ('a'),('b'),('c')").changes, 3);
		assert.equal(db.run("UPDATE ledger SET line_json='z' WHERE seq<=2").changes, 2);
		assert.equal(db.run("DELETE FROM ledger WHERE seq=99").changes, 0);
		assert.equal(db.run("DELETE FROM ledger").changes, 3);
		db.close();
	});

	test("F11 get returns undefined and all returns [] when nothing matches", () => {
		const db = open();
		db.exec(LEDGER);
		assert.equal(db.get("SELECT * FROM ledger"), undefined);
		assert.deepEqual(db.all("SELECT * FROM ledger"), []);
		db.close();
	});

	test("F12 rowid assignment and order after deletes: DoltLite NEVER reuses a seq (unlike sqlite, which reuses max+1 after the last row is deleted); order is seq order", () => {
		const db = open();
		db.exec(LEDGER);
		db.run("INSERT INTO ledger(line_json) VALUES ('a'),('b'),('c')");
		db.run("DELETE FROM ledger WHERE seq=2");
		db.run("INSERT INTO ledger(line_json) VALUES ('d')");
		assert.deepEqual(db.all<{ seq: number }>("SELECT seq FROM ledger ORDER BY seq").map((r) => r.seq), [1, 3, 4]);
		db.run("DELETE FROM ledger WHERE seq=4");
		db.run("INSERT INTO ledger(line_json) VALUES ('e')");
		assert.equal(db.get("SELECT line_json FROM ledger WHERE seq=4"), undefined, "seq 4 was not reused");
		assert.equal(db.get<{ line_json: string }>("SELECT line_json FROM ledger WHERE seq=5")?.line_json, "e");
		db.run("DELETE FROM ledger");
		db.run("INSERT INTO ledger(line_json) VALUES ('f')");
		assert.deepEqual(db.all<{ seq: number }>("SELECT seq FROM ledger").map((r) => r.seq), [6], "even an emptied table continues the counter");
		// the counter is stored with the data: it survives a seal and a reopen
		const file = db.get<{ f: string }>("SELECT file AS f FROM pragma_database_list")?.f ?? "";
		db.seal("s");
		db.close();
		const again = open(file);
		again.run("DELETE FROM ledger");
		again.run("INSERT INTO ledger(line_json) VALUES ('g')");
		assert.deepEqual(again.all<{ seq: number }>("SELECT seq FROM ledger").map((r) => r.seq), [7]);
		console.log("FACT rowid: INTEGER PRIMARY KEY seq is monotonic, never reused after deletes (even of all rows), across seal+reopen; sqlite reuses");
		again.close();
	});

	test("F12b property: after any insert/delete history the next seq is (highest ever assigned)+1 and scans come back in seq order", () => {
		fc.assert(
			fc.property(fc.array(fc.oneof(fc.constant("ins" as const), fc.integer({ min: 0, max: 20 })), { maxLength: 30 }), (ops) => {
				const db = open();
				db.exec(LEDGER);
				const live: number[] = [];
				let highest = 0;
				for (const op of ops) {
					if (op === "ins") {
						highest++;
						db.run("INSERT INTO ledger(line_json) VALUES ('x')");
						live.push(highest);
					} else {
						db.run("DELETE FROM ledger WHERE seq = ?", op);
						const i = live.indexOf(op);
						if (i >= 0) live.splice(i, 1);
					}
				}
				const got = db.all<{ seq: number }>("SELECT seq FROM ledger").map((r) => r.seq);
				db.close();
				assert.deepEqual(got, live);
			}),
			{ numRuns: 25 },
		);
	});

	test("F13 rows inserted in order read back in seq order; an explicit seq above max is honoured", () => {
		const db = open();
		db.exec(LEDGER);
		db.run("INSERT INTO ledger(line_json) VALUES ('a'),('b')");
		db.run("INSERT INTO ledger(seq, line_json) VALUES (10, 'far')");
		db.run("INSERT INTO ledger(line_json) VALUES ('after')");
		assert.deepEqual(db.all<{ seq: number; line_json: string }>("SELECT seq, line_json FROM ledger ORDER BY seq").map((r) => ({ ...r })), [
			{ seq: 1, line_json: "a" },
			{ seq: 2, line_json: "b" },
			{ seq: 10, line_json: "far" },
			{ seq: 11, line_json: "after" },
		]);
		db.close();
	});

	test("F13b seq stays append-ordered when explicit and auto seqs mix (rewriteLedgers inserts explicit seqs above max)", () => {
		const db = open();
		db.exec(LEDGER);
		db.run("INSERT INTO ledger(line_json) VALUES ('a'),('b')");
		db.run("INSERT INTO ledger(seq, line_json) VALUES (10, 'explicit')");
		db.run("INSERT INTO ledger(line_json) VALUES ('auto1')");
		const seqs = () => db.all<{ seq: number }>("SELECT seq FROM ledger ORDER BY seq").map((r) => r.seq);
		assert.deepEqual(seqs(), [1, 2, 10, 11], "auto after an explicit seq above max");
		db.run("DELETE FROM ledger WHERE seq >= 2");
		db.run("INSERT INTO ledger(seq, line_json) VALUES (3, 'explicit-below-old-high-water')");
		db.run("INSERT INTO ledger(line_json) VALUES ('auto2')");
		console.log(`FACT explicit-then-auto: [1,2,10,auto] -> ${JSON.stringify([1, 2, 10, 11])}; after delete and explicit 3 -> ${JSON.stringify(seqs())}`);
		assert.deepEqual(seqs(), [1, 3, 12], "above every existing row, and no collision");
		fc.assert(
			fc.property(fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 40 }), fc.constant(-1)), { maxLength: 25 }), (ops) => {
				const d = open();
				d.exec(LEDGER);
				const live: number[] = [];
				for (const op of ops) {
					if (op === 0) {
						d.run("INSERT INTO ledger(line_json) VALUES ('a')");
						const seq = d.get<{ m: number }>("SELECT max(seq) AS m FROM ledger")?.m as number;
						assert.ok(live.every((x) => x < seq), "auto seq is above every existing row");
						live.push(seq);
					} else if (op === -1) {
						const victim = live.pop();
						if (victim !== undefined) d.run("DELETE FROM ledger WHERE seq = ?", victim);
					} else if (!live.includes(op)) {
						d.run("INSERT INTO ledger(seq, line_json) VALUES (?, 'e')", op);
						live.push(op);
					}
				}
				const got = d.all<{ seq: number }>("SELECT seq FROM ledger ORDER BY seq").map((r) => r.seq);
				d.close();
				assert.deepEqual(got, [...live].sort((x, y) => x - y));
			}),
			{ numRuns: 30 },
		);
		db.close();
	});

	test("F14 text round-trips byte-for-byte (CRLF, NUL, astral, whole unicode range), also through a seal", () => {
		const db = open();
		db.exec(LEDGER);
		const rt = (s: string) => {
			db.run("DELETE FROM ledger");
			db.run("INSERT INTO ledger(line_json) VALUES (?)", s);
			return db.get<{ line_json: string }>("SELECT line_json FROM ledger")?.line_json;
		};
		for (const s of ["", "a\r\nb\r\n", "nul\u0000mid", "😀", '{"k":"v"}  '] as const) assert.equal(rt(s), s);
		fc.assert(fc.property(fc.string({ unit: "binary" }), (s) => rt(s) === s), { numRuns: 100 });
		db.run("DELETE FROM ledger");
		db.run("INSERT INTO ledger(line_json) VALUES (?)", "a\r\nnul\u0000😀");
		const h = db.seal("rt") as string;
		const r = openReaderAt(db.get<{ f: string }>("SELECT file AS f FROM pragma_database_list")?.f ?? "", h);
		assert.deepEqual(lines(r), ["a\r\nnul\u0000😀"]);
		r.close();
		db.close();
	});

	test("F15 null, number, bigint and blob parameters round-trip; an integer beyond 2^53 throws on read instead of rounding", () => {
		const db = open();
		db.exec("CREATE TABLE v (a, b, c, d)");
		db.run("INSERT INTO v VALUES (?, ?, ?, ?)", null, 1.5, 9007199254740993n, new Uint8Array([0, 255, 7]));
		const row = db.get<{ a: unknown; b: unknown; d: Uint8Array }>("SELECT a, b, d FROM v");
		assert.equal(row?.a, null);
		assert.equal(row?.b, 1.5);
		assert.deepEqual([...(row?.d ?? [])], [0, 255, 7]);
		assert.throws(() => db.get("SELECT c FROM v"), RangeError);
		assert.throws(() => db.all("SELECT c FROM v"), /9007199254740993/);
		assert.equal(db.get<{ c: number }>("SELECT c % 1000 AS c FROM v")?.c, 993, "stored exactly");
		db.run("DELETE FROM v");
		db.run("INSERT INTO v(a, b) VALUES (?, ?)", 9007199254740991n, -9007199254740991n);
		assert.deepEqual({ ...db.get<object>("SELECT a, b FROM v") }, { a: 9007199254740991, b: -9007199254740991 }, "the largest safe integers are plain numbers");
		assert.equal(typeof db.get<{ c: unknown }>("SELECT count(*) AS c FROM v")?.c, "number");
		db.close();
	});

	test("F16 foreign keys are enforced", () => {
		const db = open();
		db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (p_id INTEGER REFERENCES p(id))");
		assert.throws(() => db.run("INSERT INTO c VALUES (5)"), /FOREIGN KEY/);
		db.close();
	});

	test("F17 VACUUM INTO: asserts what DoltLite really does with a backup copy", () => {
		const file = fresh();
		const db = open(file);
		db.exec(LEDGER);
		db.run("INSERT INTO ledger(line_json) VALUES ('a'),('b')");
		const h1 = db.seal("two rows") as string;
		db.run("INSERT INTO ledger(line_json) VALUES ('wip')");
		const bak = path.join(dir, `bak-${n++}.db`);
		db.run("VACUUM INTO ?", bak);
		assert.ok(fs.existsSync(bak), "VACUUM INTO wrote a file");
		const copy = open(bak);
		const copied = { rows: lines(copy), log: commits(copy).map((c) => c.commit_hash), dirty: dirtyTables(copy) };
		console.log(`FACT VACUUM INTO: works; copy opens; rows=${JSON.stringify(copied.rows)} commits=${copied.log.length} (source has ${commits(db).length}) keepsHistory=${copied.log.includes(h1)} dirty=${copied.dirty}`);
		assert.deepEqual(copied.rows, ["a", "b", "wip"], "includes the uncommitted working set");
		copy.close();
		db.close();
	});

	test("F18 data survives close and reopen; a read-only handle reads but refuses writes", () => {
		const file = fresh();
		const w = open(file);
		w.exec(LEDGER);
		w.run("INSERT INTO ledger(line_json) VALUES ('kept')");
		w.close();
		const r = openDoltlite(file, { readOnly: true });
		assert.equal(count(r), 1);
		assert.throws(() => r.run("INSERT INTO ledger(line_json) VALUES ('no')"), /readonly|read-only/i);
		assert.throws(() => r.seal("nope"), /read-only/);
		r.close();
	});

	test("F19 close is idempotent and a closed driver throws", () => {
		const db = open();
		db.close();
		db.close();
		assert.throws(() => db.exec("SELECT 1"));
	});

	test("F20 an undefined parameter is refused, not stored as NULL", () => {
		const db = open();
		db.exec(LEDGER);
		assert.throws(() => db.run("INSERT INTO ledger(line_json) VALUES (?)", undefined as never));
		db.close();
	});

	test("F21 a readOnly open never creates a missing file", () => {
		const sub = fs.mkdtempSync(path.join(dir, "ro-"));
		assert.throws(() => openDoltlite(path.join(sub, "nope.db"), { readOnly: true }), /unable to open/);
		assert.deepEqual(fs.readdirSync(sub), []);
	});
});

describe("DoltLite facts", () => {
	test("brand-new store: HEAD is DoltLite's own initial commit, working set clean; doltHashOf is a content hash, not the commit hash", () => {
		const file = fresh();
		const db = open(file);
		const log = commits(db);
		assert.equal(log.length, 1);
		assert.match(log[0]?.message ?? "", /^Initialize data repository/);
		assert.equal(db.head(), log[0]?.commit_hash);
		assert.equal(dirtyTables(db), 0);
		db.exec(LEDGER);
		const sealed = db.seal("c1") as string;
		db.close();
		const raw = new (nodeRequire("@dolthub/doltlite").DatabaseSync)(file);
		const contentHash = raw.doltHashOf() as string;
		raw.close();
		console.log(`FACT HEAD on a brand-new store: ${log[0]?.commit_hash} "${log[0]?.message}"; doltHashOf after commit ${contentHash} != commit hash ${sealed}`);
		assert.notEqual(contentHash, sealed, "doltHashOf must not be used as head()");
	});

	test("seal: one commit per seal, message kept, newest first; the returned hash is head()", () => {
		const db = open();
		db.exec(LEDGER);
		const before = commits(db).length;
		db.run("INSERT INTO ledger(line_json) VALUES ('a')");
		const h = db.seal("first") as string;
		assert.equal(commits(db).length, before + 1);
		assert.deepEqual({ ...commits(db)[0] }, { commit_hash: h, message: "first" });
		assert.equal(db.head(), h);
		db.close();
	});

	test("seal on a clean working set makes no commit and returns the current head (DoltLite itself refuses an empty commit)", () => {
		const db = open();
		db.exec(LEDGER);
		const h = db.seal("one") as string;
		const n0 = commits(db).length;
		assert.equal(db.seal("again"), h);
		assert.equal(commits(db).length, n0);
		const raw = new (nodeRequire("@dolthub/doltlite").DatabaseSync)(db.get<{ f: string }>("SELECT file AS f FROM pragma_database_list")?.f);
		assert.throws(() => raw.doltCommit("empty"), /nothing to commit/);
		console.log('FACT dolt_commit on a clean set: throws "nothing to commit, working tree clean"; the driver returns head instead');
		raw.close();
		db.close();
	});

	test("seal inside a transaction throws, leaves no commit, and the transaction can still commit", () => {
		const db = open();
		db.exec(LEDGER);
		db.seal("ledger");
		const before = commits(db).length;
		db.transaction(() => {
			db.run("INSERT INTO ledger(line_json) VALUES ('a')");
			assert.throws(() => db.seal("per statement"), /inside a transaction/);
			db.transaction(() => assert.throws(() => db.seal("nested"), /inside a transaction/));
		});
		assert.equal(commits(db).length, before);
		assert.equal(count(db), 1);
		assert.equal(dirtyTables(db), 1);
		db.close();
	});

	test("seal commits the whole working set, leftovers of an earlier unsealed transaction included", () => {
		const db = open();
		db.exec(LEDGER);
		db.transaction(() => db.run("INSERT INTO ledger(line_json) VALUES ('a')"));
		db.transaction(() => db.run("INSERT INTO ledger(line_json) VALUES ('b')"));
		const h = db.seal("both") as string;
		const r = openReaderAt(db.get<{ f: string }>("SELECT file AS f FROM pragma_database_list")?.f ?? "", h);
		assert.deepEqual(lines(r), ["a", "b"]);
		r.close();
		db.close();
	});

	test("rolled-back transaction leaves the working set clean: seal makes no commit", () => {
		const db = open();
		db.exec(LEDGER);
		const h = db.seal("ledger");
		assert.throws(() =>
			db.transaction(() => {
				db.run("INSERT INTO ledger(line_json) VALUES ('x')");
				throw new Error("no");
			}),
		);
		assert.equal(dirtyTables(db), 0);
		assert.equal(db.seal("nothing"), h);
		db.close();
	});

	test("working-set durability without dolt_commit: SQL COMMIT then SIGKILL; a fresh open sees the row and a dirty status", () => {
		const file = fresh();
		const base = open(file);
		base.exec(LEDGER);
		base.seal("ledger");
		const sealedCommits = commits(base).length;
		base.close();
		const script = path.join(dir, "kill-child.mts");
		fs.writeFileSync(
			script,
			`import {openDoltlite} from ${JSON.stringify(path.join(repo, "src/store/sql/drivers/doltlite.ts"))};
const db=openDoltlite(process.argv[2]);
db.transaction(()=>db.run("INSERT INTO ledger(line_json) VALUES ('survivor')"));
process.kill(process.pid,"SIGKILL");`,
		);
		const child = spawnSync(process.execPath, ["--import", "tsx", script, file], { cwd: repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_ENV: "test" } });
		assert.equal(child.signal, "SIGKILL", `child died by SIGKILL (stderr: ${child.stderr})`);
		const seen = peek(file);
		assert.deepEqual(seen.lines, ["survivor"]);
		assert.equal(seen.dirty, 1);
		assert.equal(seen.log.length, sealedCommits, "no commit was made");
		console.log("FACT working set: durable after SQL COMMIT + SIGKILL without dolt_commit; dolt_status lists the table as modified");
	});

	test("recover at open, right lock: commits 'recovered at open' once, the working set is then clean, nothing is lost", () => {
		const { file, commitCount } = store(true);
		const db = openDoltlite(file, { lock: lockOf(file) });
		assert.equal(commits(db).length, commitCount, "open itself never commits (lh-pv9)");
		assert.equal(dirtyTables(db), 1);
		db.recover();
		assert.equal(commits(db).length, commitCount + 1);
		assert.equal(commits(db)[0]?.message, RECOVER_MESSAGE);
		assert.equal(commits(db)[0]?.commit_hash, db.head());
		assert.equal(dirtyTables(db), 0);
		assert.deepEqual(lines(db), ["base", "leftover"]);
		db.close();
		const again = openDoltlite(file, { lock: lockOf(file) });
		again.recover();
		assert.equal(commits(again).length, commitCount + 1, "second open has nothing to recover");
		again.close();
	});

	test("recover at open, refusals: no lock, readOnly, a reader and a clean store make no commit and leave a dirty set dirty", () => {
		const { file, head, commitCount } = store(true);
		const unlocked = open(file);
		unlocked.recover();
		unlocked.close();
		const ro = openDoltlite(file, { readOnly: true, lock: lockOf(file) }); // even a lock does not let a read-only handle write
		ro.recover();
		ro.close();
		assert.throws(() => openReaderAt(file, "0".repeat(40)));
		const reader = openReaderAt(file, head);
		reader.recover();
		reader.close();
		const seen = peek(file);
		assert.equal(seen.log.length, commitCount);
		assert.equal(seen.dirty, 1);
		assert.deepEqual(seen.lines, ["base", "leftover"]);

		const clean = store(false);
		const c = openDoltlite(clean.file, { lock: lockOf(clean.file) });
		c.recover();
		assert.equal(commits(c).length, clean.commitCount, "a clean store makes no commit");
		c.close();
	});

	test("recover at open, wrong lock: throws before touching the store", () => {
		const { file, commitCount } = store(true);
		const other = fresh();
		assert.throws(() => openDoltlite(file, { lock: lockOf(other) }), /not the lock of/);
		assert.throws(() => openDoltlite(file, { readOnly: true, lock: lockOf(other) }), /not the lock of/);
		const seen = peek(file);
		assert.equal(seen.log.length, commitCount);
		assert.equal(seen.dirty, 1);
	});

	test("recover at open: only a held lock matters, not a count: a second handle opened with the lock while the first is idle recovers once", () => {
		const { file, commitCount } = store(true);
		const a = openDoltlite(file, { lock: lockOf(file) });
		const b = openDoltlite(file, { lock: lockOf(file) });
		a.recover();
		b.recover();
		assert.equal(commits(b).length, commitCount + 1);
		a.close();
		b.close();
	});

	test("a lock that is not held is refused at open, and recover() refuses when the lock was released after open", () => {
		const { file, commitCount } = store(true);
		const gone = acquireStoreLock(file);
		gone.release();
		assert.throws(() => openDoltlite(file, { lock: gone }), /not held/);
		assert.throws(() => openDoltlite(file, { readOnly: true, lock: gone }), /not held/);

		const live = acquireStoreLock(file);
		const db = openDoltlite(file, { lock: live });
		live.release();
		assert.throws(() => db.recover(), /no longer held/);
		db.close();
		const seen = peek(file);
		assert.equal(seen.log.length, commitCount, "no commit was made");
		assert.equal(seen.dirty, 1, "the working set was left alone");
	});

	test("a lock evicted by another holder's content is not held", () => {
		const file = fresh();
		const lock = acquireStoreLock(file);
		assert.equal(lock.held(), true);
		fs.writeFileSync(lock.lockFile, JSON.stringify({ pid: 1, host: "other", startedAt: "2000-01-01T00:00:00.000Z" }));
		assert.equal(lock.held(), false);
		assert.throws(() => openDoltlite(file, { lock }), /not held/);
		lock.release(); // does not remove the other holder's file
		assert.ok(fs.existsSync(lockFileFor(file)));
		fs.rmSync(lockFileFor(file));
	});

	test("growth per commit: bytes added to the store file by one ledger-shaped append + seal", () => {
		const file = fresh();
		const db = open(file);
		db.exec(LEDGER);
		db.seal("ledger");
		const line = (i: number) => JSON.stringify({ i, kind: "append", text: "x".repeat(150) });
		for (let i = 0; i < 20; i++) {
			db.run("INSERT INTO ledger(line_json) VALUES (?)", line(i));
			db.seal(`warm ${i}`);
		}
		const total = () => fs.readdirSync(dir).filter((f) => f === path.basename(file) || f.startsWith(`${path.basename(file)}-`)).reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
		const start = total();
		const N = 200;
		for (let i = 0; i < N; i++) {
			db.run("INSERT INTO ledger(line_json) VALUES (?)", line(i));
			db.seal(`c ${i}`);
		}
		const perCommit = (total() - start) / N;
		db.close();
		console.log(`FACT growth per commit: ${perCommit.toFixed(0)} bytes (one ~190 byte row + one commit; ${N} commits, file+wal+shm)`);
		assert.ok(perCommit > 0, "measured something");
		assert.ok(perCommit < 64 * 1024, `bytes per commit ${perCommit} is beyond the generous 64 KiB bound`);
	});

	test("dolt_diff_<table> shows exactly the changed rows after a one-row append and after a one-row delete", () => {
		const db = open();
		db.exec(LEDGER);
		db.run("INSERT INTO ledger(line_json) VALUES ('a'),('b'),('c')");
		const h0 = db.seal("base") as string;
		db.run("INSERT INTO ledger(line_json) VALUES ('d')");
		const h1 = db.seal("append") as string;
		db.run("DELETE FROM ledger WHERE seq = 2");
		const h2 = db.seal("delete") as string;
		const diff = (from: string, to: string) =>
			db.all<{ diff_type: string; to_seq: number | null; from_seq: number | null }>("SELECT diff_type, to_seq, from_seq FROM dolt_diff_ledger WHERE from_commit = ? AND to_commit = ?", from, to).map((r) => ({ ...r }));
		assert.deepEqual(diff(h0, h1), [{ diff_type: "added", to_seq: 4, from_seq: null }]);
		assert.deepEqual(diff(h1, h2), [{ diff_type: "removed", to_seq: null, from_seq: 2 }]);
		db.close();
	});

	test("property: dolt_diff between two seals lists exactly the model's added and removed seqs", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 5 }), fc.uniqueArray(fc.integer({ min: 1, max: 5 }), { maxLength: 5 }), (adds, dels) => {
				const db = open();
				db.exec(LEDGER);
				db.run("INSERT INTO ledger(line_json) VALUES ('1'),('2'),('3'),('4'),('5'),('6')");
				const from = db.seal("base") as string;
				for (const d of dels) db.run("DELETE FROM ledger WHERE seq = ?", d); // seq 6 stays, so appends never reuse a deleted seq
				for (let i = 0; i < adds; i++) db.run("INSERT INTO ledger(line_json) VALUES ('n')");
				const to = db.seal("change") as string;
				const rows = db.all<{ diff_type: string; to_seq: number | null; from_seq: number | null }>("SELECT diff_type, to_seq, from_seq FROM dolt_diff_ledger WHERE from_commit = ? AND to_commit = ?", from, to);
				db.close();
				const added = rows.filter((r) => r.diff_type === "added").map((r) => r.to_seq).sort((x, y) => (x as number) - (y as number));
				const removed = rows.filter((r) => r.diff_type === "removed").map((r) => r.from_seq).sort((x, y) => (x as number) - (y as number));
				assert.equal(rows.length, added.length + removed.length, "no modified rows");
				assert.deepEqual(added, Array.from({ length: adds }, (_, i) => 7 + i));
				assert.deepEqual(removed, [...dels].sort((x, y) => x - y));
			}),
			{ numRuns: 25 },
		);
	});
});

describe("readers (file@hash)", () => {
	test("a reader sees the snapshot at its hash after later commits, while a writer holds a transaction, and never blocks the writer", () => {
		const file = fresh();
		const w = open(file);
		w.exec(LEDGER);
		w.run("INSERT INTO ledger(line_json) VALUES ('one')");
		const h1 = w.seal("one") as string;
		const r1 = openReaderAt(file, h1);
		w.run("INSERT INTO ledger(line_json) VALUES ('two')");
		const h2 = w.seal("two") as string;
		const r2 = openReaderAt(file, h2);
		w.transaction(() => {
			w.run("INSERT INTO ledger(line_json) VALUES ('three')");
			assert.deepEqual(lines(r1), ["one"]);
			assert.deepEqual(lines(r2), ["one", "two"], "pending writes are invisible");
		});
		w.run("INSERT INTO ledger(line_json) VALUES ('four')"); // writer proceeds with readers open
		const h3 = w.seal("three+four") as string;
		assert.deepEqual(lines(r1), ["one"]);
		assert.deepEqual(lines(r2), ["one", "two"]);
		assert.equal(r1.head(), h1);
		assert.equal(r2.head(), h2);
		assert.notEqual(h3, h2);
		for (const r of [r1, r2]) {
			assert.equal(r.engine, "doltlite");
			assert.equal(r.engineVersion, w.engineVersion);
			r.close();
			r.close();
		}
		w.close();
	});

	test("a reader refuses writes and seal; a bad, unknown or path-smuggling hash is refused; a missing file is not created", () => {
		const file = fresh();
		const w = open(file);
		w.exec(LEDGER);
		const h = w.seal("l") as string;
		w.close();
		const r = openReaderAt(file, h);
		assert.throws(() => r.run("INSERT INTO ledger(line_json) VALUES ('x')"), /readonly|read-only/i);
		assert.throws(() => r.exec("CREATE TABLE t(x)"), /readonly|read-only/i);
		assert.throws(() => r.seal("x"), /read-only/);
		r.close();
		assert.throws(() => openReaderAt(file, "0".repeat(40)), /not found/);
		for (const bad of ["", "../x", "a b", `${h}@${h}`]) assert.throws(() => openReaderAt(file, bad), /invalid commit hash/);
		const sub = fs.mkdtempSync(path.join(dir, "rd-"));
		assert.throws(() => openReaderAt(path.join(sub, "nope.db"), h), /unable to open/);
		assert.deepEqual(fs.readdirSync(sub), [], "nothing was created");
	});

	test("a reader pins the old schema too: a column added later is invisible at the old hash", () => {
		const file = fresh();
		const w = open(file);
		w.exec(LEDGER);
		const h = w.seal("l") as string;
		w.exec("ALTER TABLE ledger ADD COLUMN extra TEXT");
		w.seal("ddl");
		const r = openReaderAt(file, h);
		assert.deepEqual(r.all<{ name: string }>("SELECT name FROM pragma_table_info('ledger')").map((c) => c.name), ["seq", "line_json"]);
		r.close();
		w.close();
	});
});

describe("model-based: transaction / rollback / seal against an in-memory model", () => {
	interface Model {
		lines: string[];
		dirty: boolean;
		commitCount: number;
		snapshots: Map<string, string[]>;
		head: string;
	}
	interface Real {
		db: SqlDriver;
		file: string;
	}
	type Cmd = fc.Command<Model, Real>;

	const TxCmd = (vals: string[]): Cmd => ({
		check: () => true,
		run(m, r) {
			r.db.transaction(() => {
				for (const v of vals) r.db.run("INSERT INTO ledger(line_json) VALUES (?)", v);
			});
			m.lines.push(...vals);
			if (vals.length > 0) m.dirty = true;
			assert.deepEqual(lines(r.db), m.lines);
		},
		toString: () => `tx(${JSON.stringify(vals)})`,
	});
	const RollbackCmd = (vals: string[]): Cmd => ({
		check: () => true,
		run(m, r) {
			assert.throws(() =>
				r.db.transaction(() => {
					for (const v of vals) r.db.run("INSERT INTO ledger(line_json) VALUES (?)", v);
					throw new Error("rollback");
				}),
			);
			assert.deepEqual(lines(r.db), m.lines);
			assert.equal(dirtyTables(r.db), m.dirty ? 1 : 0, "a rollback never dirties the working set");
		},
		toString: () => `rollback(${JSON.stringify(vals)})`,
	});
	const SealCmd = (): Cmd => ({
		check: () => true,
		run(m, r) {
			const h = r.db.seal("s") as string;
			if (m.dirty) {
				assert.ok(!m.snapshots.has(h), "a new commit has a new hash");
				m.commitCount++;
				m.snapshots.set(h, [...m.lines]);
				m.head = h;
				m.dirty = false;
			} else {
				assert.equal(h, m.head, "a clean seal returns the unchanged head");
			}
			assert.equal(r.db.head(), m.head);
			assert.equal(commits(r.db).length, m.commitCount);
			assert.equal(dirtyTables(r.db), 0);
		},
		toString: () => "seal",
	});
	const ReadAtCmd = (pick: number): Cmd => ({
		check: (m) => m.snapshots.size > 0,
		run(m, r) {
			const entries = [...m.snapshots];
			const [hash, snap] = entries[pick % entries.length] as [string, string[]];
			const rd = openReaderAt(r.file, hash);
			assert.deepEqual(lines(rd), snap);
			rd.close();
		},
		toString: () => `readAt(${pick})`,
	});

	const vals = fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 });
	const cmds = fc.commands([vals.map(TxCmd), vals.map(RollbackCmd), fc.constant(SealCmd()), fc.nat(5).map(ReadAtCmd)], { maxCommands: 14 });

	test("random sequences keep rows, commit count, dirty flag and every recorded snapshot equal to the model", () => {
		fc.assert(
			fc.property(cmds, (commandList) => {
				const file = fresh();
				const db = open(file);
				db.exec(LEDGER);
				const h0 = db.seal("ledger") as string;
				const model: Model = { lines: [], dirty: false, commitCount: 2, snapshots: new Map([[h0, [] as string[]]]), head: h0 };
				try {
					fc.modelRun(() => ({ model, real: { db, file } }), commandList);
					for (const [hash, snap] of model.snapshots) {
						const rd = openReaderAt(file, hash);
						assert.deepEqual(lines(rd), snap, `reader at ${hash}`);
						rd.close();
					}
					assert.equal(commits(db).length, model.commitCount);
				} finally {
					db.close();
				}
			}),
			{ numRuns: 15 },
		);
	});
});

describe("without the addon", () => {
	test("importing the drivers and a sqlite store works with @dolthub/doltlite unresolvable; openDoltlite throws a clear error only when called", () => {
		const preload = path.join(dir, "no-addon.cjs");
		fs.writeFileSync(
			preload,
			`require("node:module").registerHooks({resolve(spec,ctx,next){if(spec.startsWith("@dolthub/doltlite"))throw Object.assign(new Error("Cannot find module '"+spec+"'"),{code:"MODULE_NOT_FOUND"});return next(spec,ctx)}});`,
		);
		const script = path.join(dir, "no-addon-child.mts");
		const sqliteFile = path.join(dir, "no-addon.sqlite");
		fs.writeFileSync(
			script,
			`const d=${JSON.stringify(path.join(repo, "src/store/sql/drivers"))};
const dl=await import(d+"/doltlite.ts");
const ns=await import(d+"/node-sqlite.ts");
let stores="loaded";try{await import(${JSON.stringify(path.join(repo, "src/server/stores.ts"))})}catch(e){stores="failed: "+(e as Error).message.split("\\n")[0]}
const db=ns.openNodeSqlite(${JSON.stringify(sqliteFile)});db.exec("CREATE TABLE t(x)");db.run("INSERT INTO t VALUES (1)");const rows=db.all("SELECT x FROM t").length;db.close();
let err:any=null;try{dl.openDoltlite(${JSON.stringify(path.join(dir, "never.db"))})}catch(e){err=e}
let rerr:any=null;try{dl.openReaderAt(${JSON.stringify(path.join(dir, "never.db"))},"abc")}catch(e){rerr=e}
console.log("RESULT "+JSON.stringify({rows,stores,message:err?.message,hasCause:err?.cause instanceof Error,reader:rerr?.message}));`,
		);
		const child = spawnSync(process.execPath, ["--require", preload, "--import", "tsx", "--import", "./tests/isolate-data-dir.ts", script], {
			cwd: repo,
			encoding: "utf8",
			timeout: 120_000,
			env: { ...process.env, NODE_ENV: "test" },
		});
		assert.equal(child.status, 0, child.stderr);
		const out = JSON.parse(child.stdout.split("\n").find((l) => l.startsWith("RESULT "))?.slice(7) ?? "null") as { rows: number; stores: string; message: string; hasCause: boolean; reader: string };
		console.log(`FACT without the addon: src/server/stores.ts ${out.stores}`);
		assert.equal(out.rows, 1);
		assert.match(out.message, /DoltLite is unavailable/);
		assert.match(out.message, /Cannot find module/);
		assert.equal(out.hasCause, true);
		assert.match(out.reader, /DoltLite is unavailable/);
		assert.ok(!fs.existsSync(path.join(dir, "never.db")));
		assert.equal(out.stores, "loaded", "the app composition root loads with no addon present");
	});
});

describe("check:pins comparePins", () => {
	const ver = fc.tuple(fc.nat(99), fc.nat(99), fc.nat(99)).map((t) => t.join("."));
	const header = (v: string) => `/**\n * Title\n * DoltLite version under test: ${v}\n */\n`;

	test("agreeing exact pins pass", () => {
		fc.assert(fc.property(ver, (v) => assert.deepEqual(comparePins(v, header(v)), [])));
	});
	test("a missing dependency is one problem", () => {
		fc.assert(fc.property(ver, (v) => comparePins(undefined, header(v)).length === 1 && /missing/.test(comparePins(undefined, header(v))[0] ?? "")));
	});
	test("a ^ ~ range, tag or prefix is refused even when it names the same version", () => {
		fc.assert(
			fc.property(ver, fc.constantFrom("^", "~", ">=", ">", "<", "v", "="), (v, p) => {
				const problems = comparePins(`${p}${v}`, header(v));
				return problems.length >= 1 && problems.some((m) => /exact x\.y\.z/.test(m));
			}),
		);
		for (const bad of ["latest", "1.x", "1.2", "1.2.3-beta.1", "1.2.3 || 2.0.0", "*", ""]) assert.ok(comparePins(bad, header("1.2.3")).some((m) => /exact/.test(m)), bad);
	});
	test("a missing or malformed header line is refused", () => {
		fc.assert(fc.property(ver, (v) => comparePins(v, "no header here").some((m) => /header line/.test(m))));
		assert.ok(comparePins("1.2.3", undefined).some((m) => /header line/.test(m)));
		assert.ok(comparePins("1.2.3", "// DoltLite version under test: 1.2.3").some((m) => /header line/.test(m)), "must be a ' * ' comment line");
	});
	test("different versions are refused, naming both", () => {
		fc.assert(
			fc.property(ver, ver, (a, b) => {
				fc.pre(a !== b);
				const problems = comparePins(a, header(b));
				return problems.length === 1 && problems[0]?.includes(a) === true && problems[0]?.includes(b) === true;
			}),
		);
	});
	test("this repository: package.json's pin matches the header of this very file", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { optionalDependencies: Record<string, string> };
		assert.deepEqual(comparePins(pkg.optionalDependencies["@dolthub/doltlite"], fs.readFileSync(fileURLToPath(import.meta.url), "utf8")), []);
	});
});
