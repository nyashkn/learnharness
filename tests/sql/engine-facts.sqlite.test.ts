/**
 * Engine facts for the node:sqlite driver (CB3). One test per fact the SQL adapter relies on.
 * The DoltLite twin (D1) must reproduce every fact that is not sqlite-specific.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import fc from "fast-check";
import type { SqlDriver } from "../../src/store/sql/driver";
import { openNodeSqlite } from "../../src/store/sql/drivers/node-sqlite";

let dir: string;
let n = 0;
before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sqlite-facts-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const fresh = () => path.join(dir, `s${n++}.sqlite`);
const open = (file = fresh()) => openNodeSqlite(file, { busyTimeoutMs: 0 });
const LEDGER = "CREATE TABLE ledger (seq INTEGER PRIMARY KEY, line_json TEXT NOT NULL)";
const count = (db: SqlDriver, table = "ledger") => db.get<{ c: number }>(`SELECT count(*) AS c FROM ${table}`)?.c;

describe("engine facts: node:sqlite", () => {
	test("F1 loads under ELECTRON_RUN_AS_NODE with the shipped Electron binary", () => {
		const electron = createRequire(import.meta.url)("electron") as string;
		assert.equal(typeof electron, "string");
		assert.ok(fs.existsSync(electron), `Electron binary missing at ${electron}`);
		const script = `const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(":memory:");d.exec("CREATE TABLE t(x)");d.exec("INSERT INTO t VALUES (41)");console.log(JSON.stringify({e:process.versions.electron,s:d.prepare("SELECT x+1 AS y, sqlite_version() AS v FROM t").get()}))`;
		const out = execFileSync(electron, ["-e", script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30_000 });
		const parsed = JSON.parse(out.trim().split("\n").at(-1) as string) as { e: string; s: { y: number; v: string } };
		assert.ok(parsed.e, "ran inside Electron, not plain node");
		assert.equal(parsed.s.y, 42);
		assert.match(parsed.s.v, /^3\.\d+\.\d+/);
	});

	test("F2 reports engine and version; seal and head are null", () => {
		const db = open();
		assert.equal(db.engine, "sqlite");
		assert.match(db.engineVersion, /^3\.\d+\.\d+/);
		assert.equal(db.seal("x"), null);
		assert.equal(db.head(), null);
		db.close();
	});

	test("F3 file stores run in WAL mode with synchronous=FULL", () => {
		const db = open();
		assert.equal(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode, "wal");
		assert.equal(db.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous, 2);
		db.close();
	});

	test("F4 transaction commits its writes and returns fn's value", () => {
		const db = open();
		db.exec(LEDGER);
		const r = db.transaction(() => {
			db.run("INSERT INTO ledger(line_json) VALUES (?)", "a");
			return 7;
		});
		assert.equal(r, 7);
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
		db.run("INSERT INTO ledger(line_json) VALUES ('after')"); // connection left usable, not stuck in a transaction
		assert.equal(count(db), 1);
		db.close();
	});

	test("F5b a failing ROLLBACK never masks the error fn threw", () => {
		const db = open();
		const boom = new Error("boom");
		assert.throws(
			() =>
				db.transaction(() => {
					db.close(); // makes the rollback itself fail
					throw boom;
				}),
			(e) => e === boom,
		);
	});

	test("F6 BEGIN IMMEDIATE: a second writer is refused (SQLITE_BUSY) while a transaction is open, a reader is not", () => {
		const file = fresh();
		const a = open(file);
		const b = open(file);
		a.exec(LEDGER);
		a.transaction(() => {
			a.run("INSERT INTO ledger(line_json) VALUES ('held')");
			assert.throws(() => b.transaction(() => undefined), /locked|busy/i);
			assert.equal(count(b), 0, "reader sees the last committed state, not pending writes");
		});
		assert.equal(count(b), 1);
		b.transaction(() => undefined); // free again after commit
		a.close();
		b.close();
	});

	test("F7 nested transaction joins the outer one: one commit, inner writes roll back with the outer", () => {
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
		db.transaction(() => db.run("INSERT INTO ledger(line_json) VALUES ('next')")); // doom flag does not leak
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

	test("F12 INTEGER PRIMARY KEY without AUTOINCREMENT assigns max(seq)+1, and reuses seq after the last row is deleted", () => {
		const db = open();
		db.exec(LEDGER);
		db.run("INSERT INTO ledger(line_json) VALUES ('a'),('b'),('c')");
		db.run("DELETE FROM ledger WHERE seq=2");
		db.run("INSERT INTO ledger(line_json) VALUES ('d')");
		assert.deepEqual(db.all<{ seq: number }>("SELECT seq FROM ledger ORDER BY seq").map((r) => r.seq), [1, 3, 4]);
		db.run("DELETE FROM ledger WHERE seq=4");
		db.run("INSERT INTO ledger(line_json) VALUES ('e')");
		assert.equal(db.get<{ line_json: string }>("SELECT line_json FROM ledger WHERE seq=4")?.line_json, "e");
		db.close();
	});

	test("F13 rows inserted in order read back in seq order; an explicit seq above max is honoured", () => {
		const db = open();
		db.exec(LEDGER);
		db.run("INSERT INTO ledger(line_json) VALUES ('a'),('b')");
		db.run("INSERT INTO ledger(seq, line_json) VALUES (10, 'far')");
		db.run("INSERT INTO ledger(line_json) VALUES ('after')");
		// rows come back with a null prototype, so compare plain copies
		assert.deepEqual(db.all<{ seq: number; line_json: string }>("SELECT seq, line_json FROM ledger ORDER BY seq").map((r) => ({ ...r })), [
			{ seq: 1, line_json: "a" },
			{ seq: 2, line_json: "b" },
			{ seq: 10, line_json: "far" },
			{ seq: 11, line_json: "after" },
		]);
		db.close();
	});

	test("F14 text round-trips byte-for-byte (CRLF, NUL, astral, whole unicode range)", () => {
		const db = open();
		db.exec(LEDGER);
		const rt = (s: string) => {
			db.run("DELETE FROM ledger");
			db.run("INSERT INTO ledger(line_json) VALUES (?)", s);
			return db.get<{ line_json: string }>("SELECT line_json FROM ledger")?.line_json;
		};
		for (const s of ["", "a\r\nb\r\n", "nul\u0000mid", "😀", "{\"k\":\"v\"}  "]) assert.equal(rt(s), s);
		fc.assert(fc.property(fc.string({ unit: "binary" }), (s) => rt(s) === s), { numRuns: 300 });
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
		// an integer beyond 2^53 is stored exactly but read back as a loud RangeError, never a rounded number
		assert.throws(() => db.get("SELECT c FROM v"), RangeError);
		assert.equal(db.get<{ c: number }>("SELECT c % 1000 AS c FROM v")?.c, 993);
		db.close();
	});

	test("F16 foreign keys are enforced", () => {
		const db = open();
		db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (p_id INTEGER REFERENCES p(id))");
		assert.throws(() => db.run("INSERT INTO c VALUES (5)"), /FOREIGN KEY/);
		db.close();
	});

	test("F17 VACUUM INTO writes a consistent backup (R5), even from WAL", () => {
		const file = fresh();
		const db = open(file);
		db.exec(LEDGER);
		db.run("INSERT INTO ledger(line_json) VALUES ('a'),('b')");
		const bak = path.join(dir, `bak-${n++}.sqlite`);
		db.run("VACUUM INTO ?", bak);
		const copy = open(bak);
		assert.equal(count(copy), 2);
		copy.close();
		db.close();
	});

	test("F18 data survives close and reopen; a read-only handle reads but refuses writes", () => {
		const file = fresh();
		const w = open(file);
		w.exec(LEDGER);
		w.run("INSERT INTO ledger(line_json) VALUES ('kept')");
		w.close();
		const r = openNodeSqlite(file, { readOnly: true });
		assert.equal(count(r), 1);
		assert.throws(() => r.run("INSERT INTO ledger(line_json) VALUES ('no')"), /readonly|read-only/i);
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
});
