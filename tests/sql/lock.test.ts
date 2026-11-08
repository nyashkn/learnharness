import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import fc from "fast-check";
import { acquireStoreLock, lockFileFor, pidIsAlive, StoreLockedError } from "../../src/store/sql/lock";

let dir: string;
let n = 0;
before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lock-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const store = () => path.join(dir, `g${n++}.sqlite`);
const leftovers = () => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("store lock (CB6)", () => {
	test("a second writer is refused and the error names the holder's pid", () => {
		const f = store();
		const a = acquireStoreLock(f, { pid: 4242, host: "h1", isAlive: () => true });
		assert.throws(
			() => acquireStoreLock(f, { pid: 99, host: "h1", isAlive: () => true }),
			(e) => e instanceof StoreLockedError && e.holder?.pid === 4242 && /pid 4242/.test(e.message),
		);
		a.release();
	});

	test("a lock whose pid is dead on this host is reclaimed", () => {
		const f = store();
		acquireStoreLock(f, { pid: 4242, host: "h1" }); // never released: the holder crashed
		const b = acquireStoreLock(f, { pid: 99, host: "h1", isAlive: (pid) => pid !== 4242 });
		assert.equal(JSON.parse(fs.readFileSync(lockFileFor(f), "utf8")).pid, 99);
		b.release();
	});

	test("a lock from another host is never reclaimed, even if the pid looks dead", () => {
		const f = store();
		acquireStoreLock(f, { pid: 4242, host: "other" });
		assert.throws(() => acquireStoreLock(f, { pid: 99, host: "h1", isAlive: () => false }), StoreLockedError);
	});

	test("an unreadable lock file is refused, not reclaimed", () => {
		const f = store();
		fs.writeFileSync(lockFileFor(f), "{not json");
		assert.throws(
			() => acquireStoreLock(f, { isAlive: () => false }),
			(e) => e instanceof StoreLockedError && e.holder === null,
		);
	});

	test("release frees the lock, is idempotent, and does not remove a lock someone else now holds", () => {
		const f = store();
		const a = acquireStoreLock(f, { pid: 1, host: "h1", isAlive: () => true });
		a.release();
		a.release();
		assert.ok(!fs.existsSync(lockFileFor(f)));
		const b = acquireStoreLock(f, { pid: 2, host: "h1", isAlive: () => true });
		a.release(); // stale handle
		assert.ok(fs.existsSync(lockFileFor(f)));
		b.release();
	});

	test("no temp files are left behind, on success or refusal", () => {
		const f = store();
		const a = acquireStoreLock(f, { pid: 1, host: "h1", isAlive: () => true });
		assert.throws(() => acquireStoreLock(f, { pid: 2, host: "h1", isAlive: () => true }));
		a.release();
		assert.deepEqual(leftovers(), []);
	});

	test("concurrent reclaim: a writer that took the lock while another judged it stale is not evicted", () => {
		const f = store();
		acquireStoreLock(f, { pid: 7, host: "h1" }); // crashed holder
		let a: ReturnType<typeof acquireStoreLock> | undefined;
		// B reads the stale lock, then (inside its liveness check) A reclaims and links its own lock
		const b = () =>
			acquireStoreLock(f, {
				pid: 20,
				host: "h1",
				isAlive: (pid) => {
					if (pid === 7 && !a) a = acquireStoreLock(f, { pid: 10, host: "h1", isAlive: () => false });
					return false;
				},
			});
		assert.throws(b, (e) => e instanceof StoreLockedError && e.holder?.pid === 10);
		assert.equal(JSON.parse(fs.readFileSync(lockFileFor(f), "utf8")).pid, 10, "A's lock survives");
		a?.release();
		assert.deepEqual(fs.readdirSync(dir).filter((x) => x.includes(".tomb") || x.endsWith(".tmp")), []);
	});

	test("property: a held lock is reclaimed iff same host and holder pid not alive", () => {
		fc.assert(
			fc.property(fc.boolean(), fc.boolean(), (sameHost, alive) => {
				const f = store();
				acquireStoreLock(f, { pid: 7, host: sameHost ? "h1" : "h2" });
				let reclaimed = true;
				try {
					acquireStoreLock(f, { pid: 8, host: "h1", isAlive: () => alive }).release();
				} catch (e) {
					assert.ok(e instanceof StoreLockedError);
					reclaimed = false;
				}
				return reclaimed === (sameHost && !alive);
			}),
			{ numRuns: 40 },
		);
	});

	test("pidIsAlive: true for this process, false for a pid that has exited", () => {
		assert.equal(pidIsAlive(process.pid), true);
		const dead = spawnSync(process.execPath, ["-e", "0"]).pid as number;
		assert.equal(pidIsAlive(dead), false);
	});
});
