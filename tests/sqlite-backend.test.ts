/**
 * lh-bhc (S5): LH_STORAGE=sqlite on an empty folder. Open never writes; the first write leaves marker + graph.sqlite together
 * and no JSONL beside it; a marker naming a deleted database refuses; the lock is taken only for a write or an upgrade.
 * Expectations come from the folder listing and a model written here, never from the code under test.
 */
import assert from "node:assert/strict";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sqlite-backend-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
process.env.HOME = path.join(root, "home");
process.env.LH_DATA_DIR = path.join(root, "singleton-data");
process.env.LH_AUTH_FILE = path.join(root, "singleton-auth.json");
process.env.LH_STORAGE = "sqlite"; // the intent every test below relies on; restored per case where it must differ

const marker = await import("../src/store/marker.ts");
const { createFileStores, runStoreScript } = await import("../src/store/file-stores.ts");
const { createGraphStore } = await import("../src/store/graph.ts");
const { createSqlGraphStores, releaseGraphDb, graphDbFile } = await import("../src/store/sql/open.ts");
const { openNodeSqlite } = await import("../src/store/sql/drivers/node-sqlite.ts");
const { StorageVersionError } = await import("../src/store/graph-format.ts");

let n = 0;
const fresh = (): string => path.join(root, `d${n++}`);
const auth = (dir: string): string => path.join(root, `auth-${path.basename(dir)}.json`);
const NODE = (id: string) => ({ id, name: id, statement: id, aliases: [], createdAt: "t", provenance: [] });
const listing = (dir: string): string[] => {
	if (!fs.existsSync(dir)) return ["ABSENT"];
	const out: string[] = [];
	const walk = (d: string) => { for (const name of fs.readdirSync(d).sort()) { const p = path.join(d, name); out.push(path.relative(dir, p)); if (fs.statSync(p).isDirectory()) walk(p); } };
	walk(dir);
	return out;
};
/** Let go of everything this process holds on a folder, so a following open is a true reopen. */
const letGo = (dir: string) => { releaseGraphDb(dir); marker.releaseStoreLock(dir); };
const ledgers = (dir: string) => listing(dir).filter((f) => /\.jsonl$/.test(f) || f.endsWith("sources.json") || f.endsWith("source-organization.json"));

type S = Awaited<ReturnType<typeof createFileStores>>;
const FAMILIES: Record<string, (s: S) => unknown> = {
	chats: (s) => s.chatStore.createChat("hello"),
	settings: (s) => s.settingsStore.writeSettings({ version: 1 } as never),
	graphAppend: (s) => s.graphStore.appendNode(NODE("a")),
	graphSource: (s) => s.graphStore.upsertSource({ id: "src_1", filePath: "/x", importedAt: "t" } as never),
	graphRewrite: (s) => s.graphStore.rewriteLedgers({ nodes: [NODE("a")] }),
	graphTransact: (s) => s.graphStore.transact("t", () => s.graphStore.appendNode(NODE("a"))),
	positions: (s) => s.graphStore.writePositions({ a: { x: 1, y: 2 } }),
	render: (s) => s.renderSettingsStore.writeRenderSettings({}),
	sourceOrg: (s) => s.sourceOrganizationStore.write(s.sourceOrganizationStore.read()),
};

describe("LH_STORAGE=sqlite on an empty folder", () => {
	it("every read leaves the folder untouched, whatever the folder was (absent or empty)", () => {
		const reads: Record<string, (s: S) => unknown> = {
			nodes: (s) => s.graphStore.readNodes(), chains: (s) => s.graphStore.readChains(), cps: (s) => s.graphStore.readCheckpoints(), cov: (s) => s.graphStore.readCoverage(),
			sources: (s) => s.graphStore.readSources(), positions: (s) => s.graphStore.readPositions(), revision: (s) => s.graphStore.revision(), org: (s) => s.sourceOrganizationStore.read(),
			chats: (s) => s.chatStore.listChats(), settings: (s) => s.settingsStore.readSettings(),
		};
		fc.assert(fc.property(fc.constantFrom("no-folder", "empty"), fc.array(fc.constantFrom(...Object.keys(reads)), { minLength: 1, maxLength: 10 }), (kind, seq) => {
			const dir = fresh();
			if (kind === "empty") fs.mkdirSync(dir);
			const before = listing(dir);
			const s = createFileStores(dir, auth(dir));
			for (const r of seq) reads[r]!(s);
			assert.deepEqual(listing(dir), before, seq.join(","));
			assert.equal(s.graphStore.revision(), 0);
			assert.deepEqual(s.graphStore.readNodes(), []);
			letGo(dir);
		}), { numRuns: 30 });
	});

	it("any FIRST write leaves marker AND graph.sqlite together, and no JSONL, sources.json or source-organization.json", () => {
		for (const [family, write] of Object.entries(FAMILIES)) {
			const dir = fresh();
			const s = createFileStores(dir, auth(dir));
			write(s);
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "storage.json"), "utf8")), { backend: "sqlite", layout: 1 }, family);
			assert.ok(fs.statSync(path.join(dir, "graph.sqlite")).size > 0, `${family}: graph.sqlite`);
			assert.deepEqual(ledgers(dir), [], `${family}: no file-family ledgers beside the database`);
			letGo(dir);
		}
	});

	it("a graph write, then a reopen with NO LH_STORAGE: the marker decides and every record is back; revision survived", () => {
		fc.assert(fc.property(fc.array(fc.constantFrom("a", "b", "c", "d"), { minLength: 1, maxLength: 6 }), (ids) => {
			const dir = fresh();
			const s = createFileStores(dir, auth(dir));
			ids.forEach((id) => s.graphStore.appendNode(NODE(id)));
			s.graphStore.upsertSource({ id: "src_1", filePath: "/x", importedAt: "t" } as never);
			const rev = s.graphStore.revision();
			assert.ok(rev > 0);
			letGo(dir);
			const old = process.env.LH_STORAGE;
			delete process.env.LH_STORAGE;
			try {
				const again = createFileStores(dir, auth(dir));
				assert.deepEqual(again.graphStore.readNodes().map((x) => x.id), ids);
				assert.deepEqual(again.graphStore.readSources().map((x) => x.id), ["src_1"]);
				assert.equal(again.graphStore.revision(), rev);
				assert.deepEqual(ledgers(dir), []);
			} finally { process.env.LH_STORAGE = old; letGo(dir); }
		}), { numRuns: 15 });
	});

	it("positions go to positions.json (a file) and the ledgers to the database", () => {
		const dir = fresh();
		const s = createFileStores(dir, auth(dir));
		s.graphStore.appendNode(NODE("a"));
		s.graphStore.writePositions({ a: { x: 3, y: 4 } });
		assert.deepEqual(s.graphStore.readPositions(), { a: { x: 3, y: 4 } });
		assert.ok(fs.existsSync(path.join(dir, "graph", "positions.json")));
		assert.equal(fs.existsSync(path.join(dir, "graph", "nodes.jsonl")), false);
		letGo(dir);
	});

	it("deleting graph.sqlite makes the folder refuse: open (StorageMarkerError) and the next write", () => {
		const dir = fresh();
		const s = createFileStores(dir, auth(dir));
		s.graphStore.appendNode(NODE("a"));
		letGo(dir);
		fs.rmSync(path.join(dir, "graph.sqlite"));
		for (const sidecar of ["graph.sqlite-wal", "graph.sqlite-shm"]) fs.rmSync(path.join(dir, sidecar), { force: true });
		const before = listing(dir);
		assert.throws(() => createFileStores(dir, auth(dir)), (e: unknown) => (e as Error).name === "StorageMarkerError" && /graph\.sqlite/.test((e as Error).message));
		assert.throws(() => marker.openDataFolder(dir, {}), (e: unknown) => (e as Error).name === "StorageMarkerError");
		assert.throws(() => marker.beforeWrite(dir), (e: unknown) => (e as Error).name === "StorageMarkerError", "a write refuses too, and does not recreate the database");
		assert.deepEqual(listing(dir), before, "nothing was recreated");
	});

	it("a script on a sqlite folder writes the database and never JSONL beside it", async () => {
		const dir = fresh();
		await runStoreScript(dir, auth(dir), (s) => { s.graphStore.appendNode(NODE("a")); s.graphStore.transact("t", () => s.graphStore.appendChain({ id: "arg_1", premises: ["a"], conclusion: "b", createdAt: "t", provenance: [] })); });
		assert.deepEqual(ledgers(dir), []);
		assert.ok(fs.existsSync(path.join(dir, "graph.sqlite")));
		assert.equal(fs.existsSync(path.join(dir, "storage.json.lock")), false, "the script released the lock");
		letGo(dir);
		const old = process.env.LH_STORAGE; delete process.env.LH_STORAGE;
		try { assert.deepEqual(createFileStores(dir, auth(dir)).graphStore.readChains().map((c) => c.id), ["arg_1"]); } finally { process.env.LH_STORAGE = old; letGo(dir); }
	});

	it("a newer graph.sqlite is refused at open with a StorageVersionError, and no lock is taken", () => {
		const dir = fresh();
		const s = createFileStores(dir, auth(dir));
		s.graphStore.appendNode(NODE("a"));
		letGo(dir);
		const db = openNodeSqlite(path.join(dir, "graph.sqlite"));
		db.run("UPDATE lh_meta SET value = '99' WHERE key = 'schema_version'");
		db.close();
		assert.throws(() => createFileStores(dir, auth(dir)), StorageVersionError);
		assert.equal(fs.existsSync(path.join(dir, "storage.json.lock")), false);
	});
});

describe("createSqlGraphStores: when beforeWrite runs", () => {
	const emitNothing = () => {};
	function rig(dir: string) {
		const calls: string[] = [];
		const positions = createGraphStore(path.join(dir, "graph"), { dataDir: dir });
		const stores = createSqlGraphStores(dir, positions, emitNothing, (d) => { calls.push(path.basename(d)); marker.beforeWrite(d); });
		return { calls, ...stores };
	}

	it("once per OUTERMOST write: bare writes one each, a transact one in total however many writes it nests, reads none", () => {
		const dir = fresh();
		const r = rig(dir);
		r.graphStore.readNodes(); r.graphStore.revision(); r.sourceOrganizationStore.read();
		assert.deepEqual(r.calls, []);
		r.graphStore.appendNode(NODE("a"));
		assert.equal(r.calls.length, 1);
		r.graphStore.transact("t", () => {
			r.graphStore.appendNode(NODE("b"));
			r.graphStore.appendChain({ id: "arg_1", premises: ["a"], conclusion: "b", createdAt: "t", provenance: [] });
			r.sourceOrganizationStore.write(r.sourceOrganizationStore.read());
			r.graphStore.transact("inner", () => r.graphStore.appendNode(NODE("c")));
		});
		assert.equal(r.calls.length, 2, "one for the whole transact");
		assert.throws(() => r.graphStore.transact("boom", () => { r.graphStore.appendNode(NODE("d")); throw new Error("boom"); }), /boom/);
		assert.equal(r.calls.length, 3, "a transact counts as a write on entry, rolled back or not");
		assert.deepEqual(r.graphStore.readNodes().map((x) => x.id), ["a", "b", "c"]);
		r.graphStore.appendNode(NODE("e"));
		assert.equal(r.calls.length, 4, "the depth counter was restored after the throw");
		letGo(dir);
	});

	it("opening an existing database at the top rung takes no lock; an existing file with no schema (an upgrade) takes it first", () => {
		const dir = fresh();
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "storage.json"), '{"backend":"sqlite","layout":1}');
		marker.releaseStoreLock(dir);
		openNodeSqlite(path.join(dir, "graph.sqlite")).close(); // exists, no lh_meta: migrating it is a write
		const upgrade = rig(dir);
		assert.deepEqual(upgrade.calls, [path.basename(dir)], "beforeWrite before the first rung");
		assert.ok(fs.existsSync(path.join(dir, "storage.json.lock")));
		upgrade.graphStore.readNodes();
		letGo(dir);
		const top = rig(dir);
		assert.deepEqual(top.calls, [], "already at the top rung: a plain open, no lock");
		assert.equal(fs.existsSync(path.join(dir, "storage.json.lock")), false);
		letGo(dir);
	});

	it("two store sets on one folder share ONE handle (several module instances in one process): a write through one is read through the other", () => {
		const dir = fresh();
		const a = rig(dir), b = rig(dir);
		a.graphStore.appendNode(NODE("a"));
		assert.deepEqual(b.graphStore.readNodes().map((x) => x.id), ["a"]);
		b.graphStore.appendNode(NODE("b"));
		assert.deepEqual(a.graphStore.readNodes().map((x) => x.id), ["a", "b"]);
		const key = graphDbFile(dir);
		assert.equal((globalThis as unknown as Record<string, Map<string, unknown>>).__lhSqlGraphHandles?.has(key), true);
		letGo(dir);
	});
});
