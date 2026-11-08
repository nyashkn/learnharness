/**
 * SQL-only failpoints (crash atomicity has no meaning for the file adapter: no cross-file atomicity).
 * Real node:sqlite driver wrapped by the test-only faulty decorator (lh-o0a). The SQL GraphStore does not
 * exist yet, so adapter-level rows are `todo` tests naming their owning bead.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { InjectedFault, faultyDriver, type Fault } from "../../../src/store/sql/drivers/faulty.ts";
import { openNodeSqlite } from "../../../src/store/sql/drivers/node-sqlite.ts";
import { acquireStoreLock, StoreLockedError } from "../../../src/store/sql/lock.ts";

let dir: string;
let n = 0;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-faulty-")); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const STEPS = 4; // writes in the unit of work below
/** One unit of work with STEPS writes after two committed seed rows. */
function setup(fault: Fault) {
	const file = path.join(dir, `f${n++}.sqlite`);
	const raw = openNodeSqlite(file, { busyTimeoutMs: 0 });
	raw.exec("CREATE TABLE ledger (seq INTEGER PRIMARY KEY, line TEXT NOT NULL)");
	raw.transaction(() => { raw.run("INSERT INTO ledger (line) VALUES (?)", "a"); raw.run("INSERT INTO ledger (line) VALUES (?)", "b"); });
	const db = faultyDriver(raw, fault);
	const work = () => db.transaction(() => {
		db.run("INSERT INTO ledger (line) VALUES (?)", "c");
		db.run("UPDATE ledger SET line = ? WHERE line = ?", "A", "a");
		db.run("DELETE FROM ledger WHERE line = ?", "b");
		db.run("INSERT INTO ledger (line) VALUES (?)", "d");
		return "ok";
	});
	const rows = (d = raw) => d.all<{ line: string }>("SELECT line FROM ledger ORDER BY seq").map((r) => r.line).join(",");
	return { file, raw, db, work, rows };
}
const SEED = "a,b";
const COMMITTED = "A,c,d";

describe("SQL failpoints (faulty driver over node:sqlite)", () => {
	it("FP-SQL-BEFORE crash before each write step leaves no trace; the same work commits without a fault", () => {
		for (let k = 1; k <= STEPS; k++) {
			const t = setup({ kind: "before", nth: k });
			assert.throws(t.work, InjectedFault);
			assert.ok(t.db.fired, `fault #${k} never fired`);
			assert.equal(t.rows(), SEED, `step ${k} left a trace`);
			t.raw.close();
		}
		const t = setup({ kind: "before", nth: STEPS + 1 });
		assert.equal(t.work(), "ok");
		assert.equal(t.db.fired, false);
		assert.equal(t.rows(), COMMITTED);
		t.raw.close();
	});

	it("FP-SQL-AFTER crash after each write step (the step ran) still rolls everything back", () => {
		for (let k = 1; k <= STEPS; k++) {
			const t = setup({ kind: "after", nth: k });
			assert.throws(t.work, InjectedFault);
			assert.ok(t.db.fired, `fault #${k} never fired`);
			assert.equal(t.db.writes.length, k, "the step must have reached the engine before the crash");
			assert.equal(t.rows(), SEED, `step ${k} left a trace`);
			t.raw.close();
		}
	});

	it("FP-SQL-COMMIT failure on COMMIT itself rolls back; the driver stays usable", () => {
		const t = setup({ kind: "commit" });
		assert.throws(t.work, InjectedFault);
		assert.ok(t.db.fired);
		assert.equal(t.rows(), SEED);
		t.raw.transaction(() => t.raw.run("INSERT INTO ledger (line) VALUES (?)", "z"));
		assert.equal(t.rows(), "a,b,z");
		t.raw.close();
	});

	it("FP-SQL-ENOSPC disk full mid-transaction rolls back with a SQLITE_FULL error and the next transaction works", () => {
		for (let k = 1; k <= STEPS; k++) {
			const t = setup({ kind: "enospc", nth: k });
			assert.throws(t.work, (e: InjectedFault) => e instanceof InjectedFault && e.code === "SQLITE_FULL" && /disk is full/.test(e.message));
			assert.ok(t.db.fired);
			assert.equal(t.rows(), SEED);
			assert.equal(t.work(), "ok", "the second attempt (space freed) must commit");
			assert.equal(t.rows(), COMMITTED);
			t.raw.close();
		}
	});

	it("FP-SQL-SEAL seal failure after COMMIT: the commit is durable (visible to a fresh handle) and only seal() throws", () => {
		const t = setup({ kind: "seal" });
		assert.equal(t.work(), "ok");
		assert.throws(() => t.db.seal("label"), InjectedFault);
		assert.ok(t.db.fired);
		const other = openNodeSqlite(t.file);
		assert.equal(t.rows(other), COMMITTED);
		other.close();
		t.raw.close();
	});

	it("FP-SQL-BUSY write-lock contention: a second writer is refused (SQLITE_BUSY) and changes nothing", () => {
		const t = setup({ kind: "before", nth: 99 });
		const other = openNodeSqlite(t.file, { busyTimeoutMs: 0 });
		t.raw.transaction(() => {
			t.raw.run("INSERT INTO ledger (line) VALUES (?)", "held");
			assert.throws(() => other.transaction(() => other.run("INSERT INTO ledger (line) VALUES (?)", "x")), /locked|busy/i);
		});
		assert.equal(t.rows(other), "a,b,held");
		other.close();
		t.raw.close();
	});

	it("FP-LOCK-HELD store lock held by a live process refuses a second writer, naming the holder", () => {
		const f = path.join(dir, `l${n++}.sqlite`);
		const a = acquireStoreLock(f, { pid: 4242, host: "h1", isAlive: () => true });
		assert.throws(() => acquireStoreLock(f, { pid: 99, host: "h1", isAlive: () => true }), (e) => e instanceof StoreLockedError && e.holder?.pid === 4242);
		a.release();
	});

	it("FP-LOCK-STALE a lock left by a dead process on this host is reclaimed; one from another host never is", () => {
		const f = path.join(dir, `l${n++}.sqlite`);
		acquireStoreLock(f, { pid: 4242, host: "h1" });
		const b = acquireStoreLock(f, { pid: 99, host: "h1", isAlive: (pid) => pid !== 4242 });
		b.release();
		const g = path.join(dir, `l${n++}.sqlite`);
		acquireStoreLock(g, { pid: 4242, host: "other" });
		assert.throws(() => acquireStoreLock(g, { pid: 99, host: "h1", isAlive: () => false }), StoreLockedError);
	});

	it("FP-FAULTY-FIRES the injector fires exactly once at the scripted step and not before (a fault that never fires is a failure)", () => {
		const t = setup({ kind: "before", nth: 2 });
		assert.throws(t.work, InjectedFault);
		assert.deepEqual(t.db.writes.length, 2);
		assert.equal(t.db.fired, true);
		t.raw.close();
	});
});
