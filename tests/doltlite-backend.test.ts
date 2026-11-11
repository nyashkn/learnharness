/**
 * lh-bkg (D3): LH_STORAGE=doltlite through the factory, the marker and the migrate tool. Modelled on sqlite-backend.test.ts.
 * Open never writes (a writable DoltLite open appends bytes even with no commit); a newer store is refused before ANY writable open;
 * the first write promotes the read-only handle, recovers a dirty working set as its own commit, and seals one commit per transact.
 * Expectations come from the folder bytes, `dolt_log` read through a separate read-only connection, and values written here.
 * Everything except the `adapterFor` host table runs on the two hosts that have an adapter (darwin-arm64, linux-x64).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-doltlite-backend-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
process.env.HOME = path.join(root, "home");
process.env.LH_DATA_DIR = path.join(root, "singleton-data");
process.env.LH_AUTH_FILE = path.join(root, "singleton-auth.json");
process.env.LH_STORAGE = "doltlite";

const marker = await import("../src/store/marker.ts");
const { createFileStores } = await import("../src/store/file-stores.ts");
const { releaseGraphDb, doltliteDbFile } = await import("../src/store/sql/open.ts");
const { openDoltlite, openReaderAt } = await import("../src/store/sql/drivers/doltlite.ts");
const { acquireStoreLock, StoreLockedError } = await import("../src/store/sql/lock.ts");
const { StorageVersionError } = await import("../src/store/graph-format.ts");

/** Every native open this process makes, recorded before the driver first loads the addon (the byte growth of a stray writable open is not reliable evidence, so the open mode is). */
const opens: { target: string; readOnly: boolean }[] = [];
// A hardcoded literal on purpose: the expected hosts must not be derived from the code under test.
const DOLTLITE_HOST = ["darwin-arm64", "linux-x64"].includes(`${process.platform}-${process.arch}`);
if (DOLTLITE_HOST) {
	const mod = createRequire(import.meta.url)("@dolthub/doltlite") as { DatabaseSync: new (target: string, options?: { readOnly?: boolean }) => unknown };
	const Original = mod.DatabaseSync;
	mod.DatabaseSync = class extends (Original as never as new (t: string, o?: { readOnly?: boolean }) => object) {
		constructor(target: string, options?: { readOnly?: boolean }) { opens.push({ target, readOnly: options?.readOnly === true }); super(target, options); }
	} as never;
}
const writableSince = (mark: number): number => opens.slice(mark).filter((o) => !o.readOnly).length;

describe("adapterFor: doltlite runs on darwin-arm64 and linux-x64 only", () => {
	const file = "/x/storage.json";
	it("win32/x64 (held for doltlite-node#13), linux/arm64, darwin/x64, win32/arm64 and other hosts are refused with NoAdapterError naming the backend", () => {
		for (const host of [{ platform: "win32", arch: "x64" }, { platform: "linux", arch: "arm64" }, { platform: "darwin", arch: "x64" }, { platform: "win32", arch: "arm64" }, { platform: "win32", arch: "ia32" }, { platform: "freebsd", arch: "x64" }]) {
			assert.throws(() => marker.adapterFor("doltlite", file, host), (e: unknown) => e instanceof marker.NoAdapterError && e.backend === "doltlite" && e.file === file, `${host.platform}/${host.arch}`);
		}
	});
	it("darwin/arm64 and linux/x64 are allowed", () => {
		for (const host of [{ platform: "darwin", arch: "arm64" }, { platform: "linux", arch: "x64" }]) {
			assert.equal(marker.adapterFor("doltlite", file, host), "doltlite", `${host.platform}/${host.arch}`);
		}
	});
	it("file and sqlite are allowed on every host", () => {
		for (const host of [{ platform: "linux", arch: "x64" }, { platform: "win32", arch: "x64" }, { platform: "darwin", arch: "arm64" }]) {
			assert.equal(marker.adapterFor("file", file, host), "file");
			assert.equal(marker.adapterFor("sqlite", file, host), "sqlite");
		}
	});
});

let n = 0;
const fresh = (): string => path.join(root, `d${n++}`);
const auth = (dir: string): string => path.join(root, `auth-${path.basename(dir)}.json`);
const NODE = (id: string) => ({ id, name: id, statement: id, aliases: [], createdAt: "t", provenance: [] });
const letGo = (dir: string) => { releaseGraphDb(dir); marker.releaseStoreLock(dir); };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** Every file under dir: relative path -> content hash. */
function tree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = sha(fs.readFileSync(p)); } };
	if (fs.existsSync(dir)) walk(dir);
	return out;
}
const lockFiles = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".lock")).sort() : []);
const markerOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "storage.json"), "utf8")) as unknown;

/** commit messages newest first, the commit hashes, and whether the working set is dirty: from a separate read-only connection. */
function disk(dir: string) {
	const ro = openDoltlite(doltliteDbFile(dir), { readOnly: true });
	try {
		const rows = ro.all<{ message: string; commit_hash: string }>("SELECT message, commit_hash FROM dolt_log");
		return { log: rows.map((r) => r.message), hashes: rows.map((r) => r.commit_hash), dirty: ro.all("SELECT * FROM dolt_status").length > 0 };
	} finally { ro.close(); }
}
/** Run `fn` on a writable connection of our own (the folder is let go first, so its lock can be taken); `seal` false leaves a dirty working set. */
function viaConnection(dir: string, fn: (db: ReturnType<typeof openDoltlite>) => void, seal = true): void {
	letGo(dir);
	const file = doltliteDbFile(dir);
	const lock = acquireStoreLock(file);
	const db = openDoltlite(file, { lock });
	try { fn(db); if (seal) db.seal("test edit"); } finally { db.close(); lock.release(); }
}
/** A folder with a clean DoltLite store holding nodes a and b, everything let go. */
function cleanStore(): string {
	const dir = fresh();
	const s = createFileStores(dir, auth(dir));
	s.graphStore.appendNode(NODE("a"));
	s.graphStore.appendNode(NODE("b"));
	letGo(dir);
	return dir;
}
const LEFTOVER = JSON.stringify(NODE("left"));
const makeDirty = (dir: string) => viaConnection(dir, (db) => { db.run("INSERT INTO ledger_nodes (line_json) VALUES (?)", LEFTOVER); }, false);

describe("doltlite backend", { skip: !DOLTLITE_HOST }, () => {
	it("a clean store and a dirty store: opening and reading write nothing (bytes, no lock files, no commit, still dirty)", () => {
		for (const dirty of [false, true]) {
			const dir = cleanStore();
			if (dirty) makeDirty(dir);
			const bytes = tree(dir), log = disk(dir);
			assert.equal(log.dirty, dirty);
			const mark = opens.length;
			const s = createFileStores(dir, auth(dir));
			s.graphStore.readNodes(); s.graphStore.readChains(); s.graphStore.readCheckpoints(); s.graphStore.readCoverage(); s.graphStore.readSources();
			s.graphStore.revision(); s.sourceOrganizationStore.read(); s.graphStore.readPositions();
			assert.deepEqual(s.graphStore.readNodes().map((x) => x.id), dirty ? ["a", "b", "left"] : ["a", "b"], "reads see the working set");
			letGo(dir);
			assert.equal(writableSince(mark), 0, `dirty=${dirty}: every native open was read-only`);
			assert.deepEqual(tree(dir), bytes, `dirty=${dirty}: bytes`);
			assert.deepEqual(lockFiles(dir), [], `dirty=${dirty}: no lock files`);
			assert.deepEqual(disk(dir), log, `dirty=${dirty}: no new commit, same dirty state`);
		}
	});

	it("reads on an empty folder leave it untouched (no addon load, no file)", () => {
		const dir = fresh();
		const s = createFileStores(dir, auth(dir));
		s.graphStore.readNodes(); s.graphStore.revision(); s.sourceOrganizationStore.read();
		assert.equal(fs.existsSync(dir), false);
		letGo(dir);
	});

	it("the first write on an empty folder: graph.doltlite first, the marker last, both lock files held", () => {
		const dir = fresh();
		const s = createFileStores(dir, auth(dir));
		s.graphStore.appendNode(NODE("a"));
		assert.deepEqual(markerOf(dir), { backend: "doltlite", layout: 1 });
		assert.ok(fs.statSync(path.join(dir, "graph.doltlite")).birthtimeMs <= fs.statSync(path.join(dir, "storage.json")).birthtimeMs, "the store file was created before the marker");
		assert.deepEqual(lockFiles(dir), ["graph.doltlite.lock", "storage.json.lock"]);
		assert.equal(marker.holdsStoreLock(dir), true);
		for (const f of lockFiles(dir)) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).pid, process.pid);
		letGo(dir);
	});

	it("a first write whose store step fails leaves NO marker (the marker is last), and the next write succeeds", () => {
		const dir = fresh();
		const s = createFileStores(dir, auth(dir));
		fs.mkdirSync(path.join(dir, "graph.doltlite"), { recursive: true }); // a directory where the file belongs
		assert.throws(() => s.graphStore.appendNode(NODE("a")));
		assert.equal(fs.existsSync(path.join(dir, "storage.json")), false);
		fs.rmSync(path.join(dir, "graph.doltlite"), { recursive: true });
		s.graphStore.appendNode(NODE("a"));
		assert.deepEqual(markerOf(dir), { backend: "doltlite", layout: 1 });
		letGo(dir);
	});

	it("labels: transact(label) is one commit with that message; nested is still one; a no-op adds none; a bare write is auto:<method>", () => {
		const dir = cleanStore();
		const s = createFileStores(dir, auth(dir));
		const base = disk(dir).log.length;
		s.graphStore.transact("my label", () => s.graphStore.appendNode(NODE("c")));
		let d = disk(dir);
		assert.equal(d.log.length, base + 1);
		assert.equal(d.log[0], "my label");
		s.graphStore.transact("outer", () => { s.graphStore.appendNode(NODE("d")); s.graphStore.transact("inner", () => s.graphStore.appendNode(NODE("e"))); });
		d = disk(dir);
		assert.equal(d.log.length, base + 2);
		assert.equal(d.log[0], "outer");
		s.graphStore.transact("nothing", () => { s.graphStore.readNodes(); });
		assert.equal(disk(dir).log.length, base + 2, "a transact that changes nothing adds no commit");
		s.graphStore.appendNode(NODE("f"));
		d = disk(dir);
		assert.equal(d.log.length, base + 3);
		assert.equal(d.log[0], "auto:appendNode");
		assert.equal(d.dirty, false);
		letGo(dir);
	});

	it("a dirty store opened and then written once: the write's commit on top, `recovered at open` beneath it holding the leftovers, both locks held", () => {
		const dir = cleanStore();
		makeDirty(dir);
		const before = disk(dir);
		const s = createFileStores(dir, auth(dir));
		assert.deepEqual(disk(dir), before, "the open committed nothing");
		s.graphStore.transact("the write", () => s.graphStore.appendNode(NODE("w")));
		const d = disk(dir);
		assert.deepEqual(d.log.slice(0, 2), ["the write", "recovered at open"]);
		assert.deepEqual(d.log.slice(2), before.log);
		assert.equal(d.dirty, false);
		const idsAt = (hash: string) => {
			const r = openReaderAt(doltliteDbFile(dir), hash);
			try { return r.all<{ line_json: string }>("SELECT line_json FROM ledger_nodes ORDER BY seq").map((x) => (JSON.parse(x.line_json) as { id: string }).id); } finally { r.close(); }
		};
		assert.deepEqual(idsAt(d.hashes[2]!), ["a", "b"], "before the recovery");
		assert.deepEqual(idsAt(d.hashes[1]!), ["a", "b", "left"], "the leftovers are in the recovered commit");
		assert.deepEqual(idsAt(d.hashes[0]!), ["a", "b", "left", "w"], "the write's own commit adds only its row");
		assert.equal(marker.holdsStoreLock(dir), true);
		assert.deepEqual(lockFiles(dir), ["graph.doltlite.lock", "storage.json.lock"]);
		letGo(dir);
	});

	describe("lh-6lx: a store migrate refuses is refused before any lock", () => {
		const breaks: [string, string][] = [
			["wrong store_kind", "UPDATE lh_meta SET value = 'chat' WHERE key = 'store_kind'"],
			["malformed revision", "UPDATE lh_meta SET value = 'x' WHERE key = 'revision'"],
		];
		for (const [name, sql] of breaks) {
			it(`${name} one rung below the top: MigrationRefusedError, no writable open, no lock file`, () => {
				const dir = cleanStore();
				viaConnection(dir, (db) => { db.run("UPDATE lh_meta SET value = '1' WHERE key = 'schema_version'"); db.run(sql); });
				const before = markerOf(dir);
				const mark = opens.length;
				assert.throws(() => createFileStores(dir, auth(dir)).graphStore.readNodes(), (e: unknown) => (e as Error).name === "MigrationRefusedError");
				assert.equal(writableSince(mark), 0, "no writable open");
				assert.deepEqual(lockFiles(dir), []);
				assert.deepEqual(markerOf(dir), before);
			});
		}
	});

	describe("a newer store is refused before any writable open", () => {
		const stamps: [string, (dir: string, dirty: boolean) => void][] = [
			["schema_version=999", (dir, dirty) => viaConnection(dir, (db) => { db.run("UPDATE lh_meta SET value = '999' WHERE key = 'schema_version'"); }, !dirty)],
			["line_format=999", (dir, dirty) => viaConnection(dir, (db) => { db.run("UPDATE lh_meta SET value = '999' WHERE key = 'line_format'"); }, !dirty)],
			["marker layout=999", (dir) => fs.writeFileSync(path.join(dir, "storage.json"), '{"backend":"doltlite","layout":999}\n')],
		];
		for (const [name, stamp] of stamps) {
			for (const dirty of [false, true]) {
				it(`${name}, ${dirty ? "dirty" : "clean"}: refused at open with StorageVersionError, bytes and commit log identical, no lock left`, () => {
					const dir = cleanStore();
					if (dirty && name === "marker layout=999") makeDirty(dir);
					stamp(dir, dirty);
					const bytes = tree(dir);
					const log = name === "marker layout=999" && !dirty ? undefined : disk(dir);
					const mark = opens.length;
					assert.throws(() => createFileStores(dir, auth(dir)), StorageVersionError);
					assert.equal(writableSince(mark), 0, "no writable open");
					assert.deepEqual(tree(dir), bytes);
					if (log) assert.deepEqual(disk(dir), log);
					assert.deepEqual(lockFiles(dir), []);
				});
			}
		}

		for (const dirty of [false, true]) {
			it(`at promotion, ${dirty ? "dirty" : "clean"}: stamped newer after the read-only open, then a write is refused, bytes and log identical, nothing recovered`, () => {
				const dir = cleanStore();
				const s = createFileStores(dir, auth(dir)); // read-only handle, no lock
				assert.deepEqual(s.graphStore.readNodes().map((x) => x.id), ["a", "b"]);
				// another process stamps the store (a raw connection of ours stands in; the app's handle is only read-only so far)
				const file = doltliteDbFile(dir);
				const lock = acquireStoreLock(file);
				const db = openDoltlite(file, { lock });
				try { db.run("UPDATE lh_meta SET value = '999' WHERE key = 'schema_version'"); if (!dirty) db.seal("stamp"); } finally { db.close(); lock.release(); }
				const bytes = tree(dir), log = disk(dir);
				const mark = opens.length;
				assert.throws(() => s.graphStore.appendNode(NODE("x")), StorageVersionError);
				assert.equal(writableSince(mark), 0, "refused before any writable open");
				assert.deepEqual(disk(dir), log, "no recovered commit, no seal");
				assert.equal(disk(dir).log.includes("recovered at open"), false);
				const after = tree(dir);
				for (const f of Object.keys(bytes)) if (!f.endsWith(".lock")) assert.equal(after[f], bytes[f], f);
				letGo(dir);
			});
		}
	});

	describe("a DoltLite store below the top rung is upgraded at open, under both locks", () => {
		/** A marked DoltLite folder whose graph.doltlite has a head but no lh_meta table (schema version 0). */
		function oldStore(): string {
			const dir = fresh();
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "storage.json"), '{"backend":"doltlite","layout":1}\n');
			const file = doltliteDbFile(dir);
			const lock = acquireStoreLock(file);
			const db = openDoltlite(file, { lock });
			try { db.run("CREATE TABLE unrelated (x INTEGER)"); db.seal("old store"); } finally { db.close(); lock.release(); }
			return dir;
		}
		const positions = { readPositions: () => ({}), writePositions: () => {} };

		it("createFileStores on it upgrades at the first read: lh_meta exists and the log shows the migrate commit, both locks held", () => {
			const dir = oldStore();
			const s = createFileStores(dir, auth(dir));
			assert.deepEqual(s.graphStore.readNodes(), []);
			const ro = openDoltlite(doltliteDbFile(dir), { readOnly: true });
			try { assert.equal(ro.all<{ value: string }>("SELECT value FROM lh_meta WHERE key = 'schema_version'").length, 1); } finally { ro.close(); }
			assert.ok(disk(dir).log.length >= 2 && disk(dir).log[0] !== "old store", `log: ${disk(dir).log.join(" | ")}`);
			assert.equal(marker.holdsStoreLock(dir), true);
			letGo(dir);
		});

		it("another process stamps it newer after the lock is taken: StorageVersionError, and no writable open after the stamp", async () => {
			const { createSqlGraphStores: create } = await import("../src/store/sql/open.ts");
			const dir = oldStore();
			let mark = -1;
			const racing = (d: string) => {
				const lock = marker.beforeWrite(d);
				const file = doltliteDbFile(d);
				const db = openDoltlite(file, { lock });
				try { db.run("CREATE TABLE lh_meta (key TEXT PRIMARY KEY, value TEXT)"); db.run("INSERT INTO lh_meta VALUES ('schema_version', '999')"); db.seal("stamp"); } finally { db.close(); }
				mark = opens.length;
				return lock;
			};
			assert.throws(() => create(dir, positions, () => {}, racing, "doltlite"), StorageVersionError);
			assert.ok(mark >= 0, "the race ran");
			assert.equal(writableSince(mark), 0, "refused before any writable open under the lock");
			letGo(dir);
		});
	});

	it("a store lock held by another process: the write is refused with StoreLockedError naming the holder, and no store byte changes", async () => {
		for (const which of ["graph.doltlite", "storage.json"] as const) {
			const dir = cleanStore();
			const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" }); // not `sleep`: no such binary on Windows outside Git Bash
			try {
				const theirs = acquireStoreLock(path.join(dir, which), { pid: holder.pid });
				const store = tree(dir)["graph.doltlite"], log = disk(dir);
				const s = createFileStores(dir, auth(dir));
				assert.throws(() => s.graphStore.appendNode(NODE("x")), (e: unknown) => e instanceof StoreLockedError && e.holder?.pid === holder.pid);
				assert.equal(tree(dir)["graph.doltlite"], store, which);
				assert.deepEqual(disk(dir), log);
				assert.deepEqual(lockFiles(dir), [`${which}.lock`], "only the holder's lock file is left; ours was released");
				theirs.release();
			} finally { holder.kill(); letGo(dir); }
		}
	});

	it("the marker names doltlite but the store is missing: refused at open, and at write (the store is not recreated)", () => {
		const dir = cleanStore();
		const s = createFileStores(dir, auth(dir));
		s.graphStore.appendNode(NODE("c"));
		letGo(dir);
		fs.rmSync(path.join(dir, "graph.doltlite"), { recursive: true, force: true });
		assert.throws(() => createFileStores(dir, auth(dir)), (e: unknown) => (e as Error).name === "StorageMarkerError" && /graph\.doltlite/.test((e as Error).message));
		assert.throws(() => marker.beforeWrite(dir), (e: unknown) => (e as Error).name === "StorageMarkerError");
		assert.throws(() => s.graphStore.appendNode(NODE("d")), (e: unknown) => (e as Error).name === "StorageMarkerError");
		assert.equal(fs.existsSync(path.join(dir, "graph.doltlite")), false);
		letGo(dir);
	});

	it("lockDataFolder(...).held() goes false when the store lock file is lost", () => {
		const dir = fresh();
		const lock = marker.lockDataFolder(dir);
		try {
			assert.equal(lock.held(), true);
			fs.rmSync(path.join(dir, "graph.doltlite.lock"));
			assert.equal(lock.held(), false);
		} finally { lock.release(); }
	});

	it("GET /api/graph/sources reports keepsHistory true on a DoltLite folder, and a source write is a commit", async () => {
		const { GET, POST } = await import("../app/api/graph/sources/route.ts");
		assert.equal((await (await GET()).json()).keepsHistory, true);
		const res = await POST(new Request("http://localhost/api/graph/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create-folder", name: "F", parentId: null }) }));
		assert.equal(res.status, 200);
		assert.ok(disk(process.env.LH_DATA_DIR!).log.length >= 2);
		assert.equal(disk(process.env.LH_DATA_DIR!).dirty, false);
	});
});
