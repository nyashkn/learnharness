/**
 * lh-dlo: the folder lock AND the store file's lock (doltlite). Real lock files in temp dirs;
 * "held by another" is a lock file written under a fake host, never a live process.
 * Expectations are file existence checks written here, not the code's own answers.
 */
import assert from "node:assert/strict";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-folder-locks-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
process.env.HOME = path.join(root, "home"); // the machine id file goes here
process.env.LH_DATA_DIR = path.join(root, "singleton-data");
process.env.LH_AUTH_FILE = path.join(root, "singleton-auth.json");
delete process.env.LH_STORAGE;

const { takeFolderLocks, holdsStoreLock, releaseStoreLock, lockDataFolder, beforeWrite } = await import("../src/store/marker.ts");
const { acquireStoreLock, StoreLockedError } = await import("../src/store/sql/lock.ts");
const { doltliteDbFile } = await import("../src/store/sql/open.ts");
const { openDoltlite, RECOVER_MESSAGE } = await import("../src/store/sql/drivers/doltlite.ts");

let n = 0;
const fresh = (): string => {
	const dir = path.join(root, `d${n++}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};
const MARKER_LOCK = "storage.json.lock";
const STORE_LOCK = "graph.doltlite.lock";
const has = (dir: string, name: string): boolean => fs.existsSync(path.join(dir, name));
const FOREIGN = { pid: 4242, host: "another-host" }; // a different host is never judged stale

/** Put a lock for `name`'s store file in `dir` that belongs to someone else. */
const foreignLock = (dir: string, storeFile: string) => acquireStoreLock(path.join(dir, storeFile), FOREIGN);

/** Registers a Held for `dir` in the process registry the way beforeWrite does (the doltlite branch of beforeWrite is not reachable before D3). */
function register(dir: string, held: ReturnType<typeof takeFolderLocks>): void {
	const g = globalThis as unknown as Record<string, Map<string, unknown>>;
	(g.__lhStoreLocks ??= new Map()).set(path.resolve(dir), held);
}

describe("takeFolderLocks", () => {
	it("doltlite takes the marker lock and the store lock; file and sqlite only the marker lock", () => {
		for (const [backend, store] of [["doltlite", true], ["file", false], ["sqlite", false]] as const) {
			const dir = fresh();
			const held = takeFolderLocks(dir, backend);
			assert.equal(has(dir, MARKER_LOCK), true, backend);
			assert.equal(has(dir, STORE_LOCK), store, backend);
			assert.equal(held.store !== undefined, store, backend);
			held.store?.release();
			held.lock.release();
		}
	});

	it("a store lock held by another is refused and the marker lock is not left behind", () => {
		const dir = fresh();
		foreignLock(dir, "graph.doltlite");
		assert.throws(() => takeFolderLocks(dir, "doltlite"), StoreLockedError);
		assert.equal(has(dir, MARKER_LOCK), false);
		assert.equal(has(dir, STORE_LOCK), true, "the other holder's lock is untouched");
	});

	it("a marker lock held by another is refused and no store lock is made", () => {
		const dir = fresh();
		foreignLock(dir, "storage.json");
		assert.throws(() => takeFolderLocks(dir, "doltlite"), StoreLockedError);
		assert.equal(has(dir, STORE_LOCK), false);
		assert.equal(has(dir, MARKER_LOCK), true);
	});

	it("hands the driver a real store lock: recovery runs; the marker lock is still refused", () => {
		const dir = fresh();
		const file = doltliteDbFile(dir);
		const seed = openDoltlite(file); // no lock: only to build a dirty store
		seed.exec("CREATE TABLE ledger (seq INTEGER PRIMARY KEY, line_json TEXT NOT NULL)");
		seed.run("INSERT INTO ledger(line_json) VALUES ('base')");
		seed.seal("base");
		seed.run("INSERT INTO ledger(line_json) VALUES ('leftover')");
		seed.close();
		const held = takeFolderLocks(dir, "doltlite");
		try {
			assert.throws(() => openDoltlite(file, { lock: held.lock }), /is not the lock of/);
			const db = openDoltlite(file, { lock: held.store });
			db.recover();
			assert.equal(db.all<{ message: string }>("SELECT message FROM dolt_log")[0]?.message, RECOVER_MESSAGE);
			db.close();
		} finally {
			held.store?.release();
			held.lock.release();
		}
	});
});

describe("holding, releasing, losing", () => {
	it("releaseStoreLock removes both files; losing either file means not held", () => {
		fc.assert(
			fc.property(fc.constantFrom("marker", "store", "none"), (lose) => {
				const dir = fresh();
				const held = takeFolderLocks(dir, "doltlite");
				register(dir, held);
				assert.equal(holdsStoreLock(dir), true);
				if (lose === "marker") fs.rmSync(path.join(dir, MARKER_LOCK));
				if (lose === "store") fs.rmSync(path.join(dir, STORE_LOCK));
				assert.equal(holdsStoreLock(dir), lose === "none");
				releaseStoreLock(dir);
				assert.equal(has(dir, MARKER_LOCK), false);
				assert.equal(has(dir, STORE_LOCK), false);
			}),
			{ numRuns: 24 },
		);
	});

	it("another process's lock file (a different token) in place of either of ours means not held", () => {
		for (const which of [MARKER_LOCK, STORE_LOCK]) {
			const dir = fresh();
			const held = takeFolderLocks(dir, "doltlite");
			register(dir, held);
			assert.equal(holdsStoreLock(dir), true);
			const file = path.join(dir, which);
			fs.writeFileSync(file, JSON.stringify({ pid: 1, host: "another-machine", startedAt: "2020-01-01T00:00:00.000Z" })); // same shape, not our text
			assert.equal(holdsStoreLock(dir), false, `${which} held by another token still counted as ours`);
			fs.rmSync(file);
			releaseStoreLock(dir);
		}
	});

	it("lockDataFolder: held() is true while both are held, release drops the registry entry", () => {
		const dir = fresh();
		const lock = lockDataFolder(dir);
		assert.equal(lock.held(), true);
		assert.equal(has(dir, MARKER_LOCK), true);
		lock.release();
		assert.equal(lock.held(), false);
		assert.equal(has(dir, MARKER_LOCK), false);
		assert.equal(holdsStoreLock(dir), false);
	});

	it("re-acquiring after losing the marker lock does not leak the surviving store lock", () => {
		const dir = fresh();
		const held = takeFolderLocks(dir, "doltlite");
		register(dir, held);
		fs.rmSync(path.join(dir, MARKER_LOCK)); // half-lost pair
		assert.equal(holdsStoreLock(dir), false);
		beforeWrite(dir); // file backend (no marker, no LH_STORAGE): must release the old pair before it takes a new one
		assert.equal(has(dir, STORE_LOCK), false, "the surviving store lock was released");
		assert.equal(has(dir, MARKER_LOCK), true);
		releaseStoreLock(dir);
		assert.equal(has(dir, MARKER_LOCK), false);
	});
});
