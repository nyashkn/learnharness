/**
 * blobs.sqlite CAS (lh-a0t) + chat imageSnapshots stored by hash. MECE by failpoint: round-trip, duplicate,
 * sniff, durability pragma, bytes-before-reference, legacy lazy move, missing bytes, newer-file refusal, model run.
 * Expected values come from node:crypto and a test-side magic table, never from the code under test.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import fc from "fast-check";
import type { ImageSnapshot } from "../src/core/contracts";
import { createBlobStore, type BlobStore } from "../src/store/cas/blob-store";
import { createChatStore } from "../src/store/chats";
import type { SqlDriver } from "../src/store/sql/driver";
import { openNodeSqlite } from "../src/store/sql/drivers/node-sqlite";
import { MigrationRefusedError } from "../src/store/sql/migrate";

let root: string;
let n = 0;
before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cas-"));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
const freshDir = () => {
	const d = path.join(root, `d${n++}`);
	fs.mkdirSync(d, { recursive: true });
	return d;
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const bytesArb = fc.uint8Array({ minLength: 0, maxLength: 200 });
const sqlRows = <T>(file: string, sql: string, ...p: (string | number)[]): T[] => {
	const db = openNodeSqlite(file);
	try {
		return db.all<T>(sql, ...p).map((r) => ({ ...r }));
	} finally {
		db.close();
	}
};

/** Test-side magic table (independent of the implementation). */
const bytesOf = (s: string) => [...s].map((c) => c.charCodeAt(0));
const MAGICS: { type: string; head: number[]; at?: number; gap?: number }[] = [
	{ type: "image/png", head: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
	{ type: "image/jpeg", head: [0xff, 0xd8, 0xff] },
	{ type: "image/gif", head: bytesOf("GIF87a") },
	{ type: "image/gif", head: bytesOf("GIF89a") },
	{ type: "image/webp", head: [...bytesOf("RIFF"), 0, 0, 0, 0, ...bytesOf("WEBP")] },
	{ type: "application/pdf", head: bytesOf("%PDF-") },
];
const startsWithMagic = (b: Uint8Array) => MAGICS.some((m) => m.head.every((x, i) => (m.type === "image/webp" && i >= 4 && i < 8 ? true : b[i] === x)));

describe("blob store", () => {
	test("put/get round-trip: key is an independent sha256, byteLen right", () => {
		const store = createBlobStore(path.join(freshDir(), "blobs.sqlite"));
		fc.assert(
			fc.property(bytesArb, (bytes) => {
				const put = store.put(bytes);
				assert.equal(put.hash, sha(bytes));
				assert.equal(put.byteLen, bytes.length);
				const got = store.get(sha(bytes));
				assert.ok(got);
				assert.deepEqual(Buffer.from(got.bytes), Buffer.from(bytes));
				assert.equal(got.byteLen, bytes.length);
			}),
			{ numRuns: 25 },
		);
	});

	test("duplicate put is a no-op: one row, stored row untouched (even a tampered type survives)", () => {
		const file = path.join(freshDir(), "blobs.sqlite");
		const store = createBlobStore(file);
		fc.assert(
			fc.property(bytesArb, (bytes) => {
				const h = sha(bytes);
				store.put(bytes);
				sqlRows(file, "UPDATE cas_objects SET content_type = 'sentinel/x' WHERE hash = ? RETURNING hash", h);
				store.put(bytes);
				const rows = sqlRows<{ content_type: string; n: number }>(file, "SELECT content_type, (SELECT count(*) FROM cas_objects WHERE hash = ?) AS n FROM cas_objects WHERE hash = ?", h, h);
				assert.deepEqual(rows, [{ content_type: "sentinel/x", n: 1 }]);
			}),
			{ numRuns: 15 },
		);
	});

	test("sniff: each magic + random tail gives its type; no known magic gives octet-stream", () => {
		const store = createBlobStore(path.join(freshDir(), "blobs.sqlite"));
		fc.assert(
			fc.property(fc.constantFrom(...MAGICS), fc.uint8Array({ maxLength: 40 }), (m, tail) => {
				assert.equal(store.put(Uint8Array.from([...m.head, ...tail])).contentType, m.type);
			}),
			{ numRuns: 40 },
		);
		fc.assert(
			fc.property(
				bytesArb.filter((b) => !startsWithMagic(b)),
				(b) => assert.equal(store.put(b).contentType, "application/octet-stream"),
			),
			{ numRuns: 40 },
		);
	});

	test("writes through a synchronous=FULL handle", () => {
		const seen: unknown[] = [];
		const store = createBlobStore(path.join(freshDir(), "blobs.sqlite"), {
			open: (f) => {
				const db = openNodeSqlite(f);
				seen.push(db.get("PRAGMA synchronous"));
				return db;
			},
		});
		store.put(Uint8Array.of(1, 2, 3));
		assert.deepEqual(seen.map((r) => ({ ...(r as object) })), [{ synchronous: 2 }]);
	});

	test("a newer blobs.sqlite is refused on put and get", () => {
		const file = path.join(freshDir(), "blobs.sqlite");
		const store = createBlobStore(file);
		const h = store.put(Uint8Array.of(9)).hash;
		sqlRows(file, "UPDATE lh_meta SET value = '99' WHERE key = 'schema_version' RETURNING key");
		assert.throws(() => store.put(Uint8Array.of(1)), MigrationRefusedError);
		assert.throws(() => store.get(h), MigrationRefusedError);
	});

	test("get on a missing file is undefined and creates nothing", () => {
		const dir = freshDir();
		assert.equal(createBlobStore(path.join(dir, "blobs.sqlite")).get(sha(Uint8Array.of(1))), undefined);
		assert.deepEqual(fs.readdirSync(dir), []);
	});
});

describe("chat store on the CAS", () => {
	const snapOf = (bytes: Uint8Array, width = 3, height = 4): [string, ImageSnapshot] => [sha(bytes), { mimeType: "image/png", data: b64(bytes), width, height }];
	function setup(blobs?: BlobStore) {
		const dataDir = freshDir();
		const chatsDir = path.join(dataDir, "chats");
		fs.mkdirSync(chatsDir);
		const store = createChatStore(chatsDir, { dataDir, ...(blobs ? { blobs } : {}) });
		return { dataDir, chatsDir, store, blobsFile: path.join(dataDir, "blobs.sqlite") };
	}
	const writeLegacy = (chatsDir: string, id: string, imageSnapshots: Record<string, unknown>) => {
		const file = path.join(chatsDir, `${id}.json`);
		fs.writeFileSync(file, JSON.stringify({ id, title: "t", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", messages: [], imageSnapshots }, null, "\t"));
		return file;
	};
	const raw = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as { imageSnapshots: Record<string, Record<string, unknown>> };
	const failing: BlobStore = { put: () => { throw new Error("disk full"); }, get: () => undefined, sweep: () => 0 };

	test("bytes before reference: a failing put leaves the chat JSON byte-identical (new snapshot and legacy save)", () => {
		const { chatsDir, store } = setup(failing);
		const chat = store.createChat("c");
		const file = path.join(chatsDir, `${chat.id}.json`);
		const before = fs.readFileSync(file);
		const [h, snap] = snapOf(Uint8Array.of(1, 2, 3));
		assert.throws(() => store.saveImageSnapshot(chat.id, h, snap), /disk full/);
		assert.deepEqual(fs.readFileSync(file), before);
		const legacy = writeLegacy(chatsDir, "legacy1", { [h]: snap });
		const legacyBefore = fs.readFileSync(legacy);
		assert.throws(() => store.saveMessages("legacy1", []), /disk full/);
		assert.deepEqual(fs.readFileSync(legacy), legacyBefore);
	});

	test("legacy inline snapshots load as-is, move to the CAS on the next save, still read back equal", () => {
		fc.assert(
			fc.property(fc.array(fc.uint8Array({ minLength: 1, maxLength: 60 }), { minLength: 1, maxLength: 4 }), (blobsIn) => {
				const { chatsDir, store, blobsFile } = setup();
				const input = Object.fromEntries(blobsIn.map((b, i) => snapOf(b, i + 1, i + 2)));
				const file = writeLegacy(chatsDir, "old", input);
				assert.deepEqual(store.getChat("old")?.imageSnapshots, input);
				assert.deepEqual(raw(file).imageSnapshots, input, "a read never rewrites");
				assert.equal(fs.existsSync(blobsFile), false, "a read never creates blobs.sqlite");
				store.saveMessages("old", []);
				for (const [h, s] of Object.entries(raw(file).imageSnapshots)) {
					assert.equal("data" in s, false);
					assert.deepEqual(sqlRows(blobsFile, "SELECT hash FROM cas_objects WHERE hash = ?", h), [{ hash: h }]);
				}
				assert.deepEqual(store.getChat("old")?.imageSnapshots, input);
			}),
			{ numRuns: 10 },
		);
	});

	test("an inline entry whose hash does not match its key stays inline", () => {
		const { chatsDir, store } = setup();
		const [, snap] = snapOf(Uint8Array.of(7, 7, 7));
		const wrongKey = sha(Uint8Array.of(8));
		const file = writeLegacy(chatsDir, "bad", { [wrongKey]: snap });
		store.saveMessages("bad", []);
		assert.deepEqual(raw(file).imageSnapshots, { [wrongKey]: snap });
		assert.deepEqual(store.getChat("bad")?.imageSnapshots, { [wrongKey]: snap });
	});

	test("missing bytes: the entry is absent from getChat; no blobs.sqlite is created by reading or saving", () => {
		const { chatsDir, store, blobsFile } = setup();
		const [h, { data: _data, ...stored }] = snapOf(Uint8Array.of(5, 5));
		writeLegacy(chatsDir, "gone", { [h]: stored });
		const quiet = console.error;
		console.error = () => {};
		try {
			assert.deepEqual(store.getChat("gone")?.imageSnapshots, {});
		} finally {
			console.error = quiet;
		}
		store.saveMessages("gone", []);
		assert.equal(fs.existsSync(blobsFile), false);
	});

	test("saveImageSnapshot heals a by-hash entry whose bytes went missing", () => {
		const { store, blobsFile } = setup();
		const chat = store.createChat("c");
		const [h, snap] = snapOf(Uint8Array.of(4, 2));
		store.saveImageSnapshot(chat.id, h, snap);
		for (const s of ["", "-wal", "-shm"]) fs.rmSync(blobsFile + s, { force: true });
		store.saveImageSnapshot(chat.id, h, snap);
		assert.deepEqual(store.getChat(chat.id)?.imageSnapshots, { [h]: snap });
	});

	test("model run: saveImageSnapshot / saveMessages / getChat / re-create store", () => {
		type Model = { snaps: Map<string, ImageSnapshot> };
		type Real = { dataDir: string; chatsDir: string; id: string; store: ReturnType<typeof createChatStore> };
		const rawNow = (r: Real) => raw(path.join(r.chatsDir, `${r.id}.json`)).imageSnapshots ?? {};
		class Save implements fc.Command<Model, Real> {
			constructor(readonly bytes: Uint8Array, readonly w: number) {}
			check = () => true;
			run(m: Model, r: Real) {
				const [h, snap] = snapOf(this.bytes, this.w, this.w + 1);
				r.store.saveImageSnapshot(r.id, h, snap);
				if (!m.snaps.has(h)) m.snaps.set(h, snap); // first save wins (existing entry returns early)
			}
			toString = () => `save(${this.bytes.length}b,${this.w})`;
		}
		class Msgs implements fc.Command<Model, Real> {
			check = () => true;
			run(_m: Model, r: Real) {
				r.store.saveMessages(r.id, []);
			}
			toString = () => "saveMessages";
		}
		class Get implements fc.Command<Model, Real> {
			check = () => true;
			run(m: Model, r: Real) {
				assert.deepEqual(r.store.getChat(r.id)?.imageSnapshots ?? {}, Object.fromEntries(m.snaps));
				for (const s of Object.values(rawNow(r))) assert.equal("data" in s, false);
			}
			toString = () => "getChat";
		}
		class Reopen implements fc.Command<Model, Real> {
			check = () => true;
			run(_m: Model, r: Real) {
				r.store = createChatStore(r.chatsDir, { dataDir: r.dataDir });
			}
			toString = () => "reopen";
		}
		fc.assert(
			fc.property(
				fc.commands(
					[
						fc.tuple(fc.uint8Array({ minLength: 1, maxLength: 20 }), fc.integer({ min: 1, max: 5 })).map(([b, w]) => new Save(b, w)),
						fc.constant(new Msgs()),
						fc.constant(new Get()),
						fc.constant(new Reopen()),
					],
					{ maxCommands: 12 },
				),
				(cmds) => {
					const { dataDir, chatsDir, store } = setup();
					const real: Real = { dataDir, chatsDir, store, id: store.createChat("m").id };
					fc.modelRun(() => ({ model: { snaps: new Map() }, real }), cmds);
				},
			),
			{ numRuns: 15 },
		);
	});
});

describe("deleteChat sweeps unreferenced blobs (lh-kha)", () => {
	const mk = () => {
		const dataDir = freshDir();
		const chatsDir = path.join(dataDir, "chats");
		fs.mkdirSync(chatsDir);
		const blobsFile = path.join(dataDir, "blobs.sqlite");
		return { dataDir, chatsDir, blobsFile, store: createChatStore(chatsDir, { dataDir }), raw: createBlobStore(blobsFile) };
	};
	const casHashes = (file: string) => (fs.existsSync(file) ? sqlRows<{ hash: string }>(file, "SELECT hash FROM cas_objects").map((r) => r.hash).sort() : []);
	const imgOf = (bytes: Uint8Array): [string, ImageSnapshot] => [sha(bytes), { mimeType: "image/png", data: b64(bytes), width: 1, height: 1 }];
	// a small pool so chats share images
	const POOL: Uint8Array[] = [1, 2, 3, 4].map((i) => new Uint8Array([i, i * 7, 9]));
	const pool = (i: number) => POOL[i] as Uint8Array;

	test("model run: save-with-image / delete-chat / crashed-save never lose a referenced blob", () => {
		type Model = { chats: Map<string, Set<string>> };
		type Real = ReturnType<typeof mk> & { ids: string[] };
		const referenced = (m: Model) => new Set([...m.chats.values()].flatMap((s) => [...s]));
		class Save implements fc.Command<Model, Real> {
			constructor(readonly chat: number, readonly img: number) {}
			check = (m: Model) => m.chats.size > 0;
			run(m: Model, r: Real) {
				const id = r.ids[this.chat % r.ids.length] as string;
				if (!m.chats.has(id)) return;
				const [h, snap] = imgOf(pool(this.img));
				r.store.saveImageSnapshot(id, h, snap);
				m.chats.get(id)?.add(h);
			}
			toString = () => `save(chat${this.chat},img${this.img})`;
		}
		class Crash implements fc.Command<Model, Real> {
			constructor(readonly img: number) {}
			check = () => true;
			run(_m: Model, r: Real) {
				r.raw.put(pool(this.img)); // bytes committed, JSON never written
			}
			toString = () => `crashedSave(img${this.img})`;
		}
		class Del implements fc.Command<Model, Real> {
			constructor(readonly chat: number) {}
			check = () => true;
			run(m: Model, r: Real) {
				const id = r.ids[this.chat % r.ids.length] as string;
				const existed = m.chats.delete(id);
				assert.equal(r.store.deleteChat(id), existed);
				if (existed) assert.deepEqual(casHashes(r.blobsFile), [...referenced(m)].sort()); // (b) exact after a real delete
				for (const [cid, hs] of m.chats) for (const h of hs) assert.equal(r.store.getChat(cid)?.imageSnapshots?.[h]?.data, b64(pool(POOL.findIndex((p) => sha(p) === h)))); // (a)
			}
			toString = () => `delete(chat${this.chat})`;
		}
		const idx = fc.integer({ min: 0, max: 2 });
		const img = fc.integer({ min: 0, max: POOL.length - 1 });
		fc.assert(
			fc.property(
				fc.commands([fc.tuple(idx, img).map(([c, i]) => new Save(c, i)), img.map((i) => new Crash(i)), idx.map((c) => new Del(c))], { maxCommands: 20 }),
				(cmds) => {
					const e = mk();
					const ids = [0, 1, 2].map((i) => e.store.createChat(`c${i}`).id);
					const real: Real = { ...e, ids };
					fc.modelRun(() => ({ model: { chats: new Map(ids.map((id) => [id, new Set<string>()])) }, real }), cmds);
				},
			),
			{ numRuns: 40 },
		);
	});

	const orphanThenDelete = (breakChats: (e: ReturnType<typeof mk>) => void) => {
		const e = mk();
		const keep = e.store.createChat("keep");
		const gone = e.store.createChat("gone");
		const [h, snap] = imgOf(pool(0));
		e.store.saveImageSnapshot(keep.id, h, snap);
		e.raw.put(pool(1)); // orphan
		breakChats(e);
		const errs: string[] = [];
		const orig = console.error;
		console.error = (...a: unknown[]) => void errs.push(a.join(" "));
		try {
			assert.equal(e.store.deleteChat(gone.id), true);
		} finally {
			console.error = orig;
		}
		return { e, errs, h };
	};

	test("regression (shrunk counterexample): crashedSave then delete-chat leaves no orphan", () => {
		const e = mk();
		const c = e.store.createChat("c");
		e.raw.put(pool(0));
		e.store.deleteChat(c.id);
		assert.deepEqual(casHashes(e.blobsFile), []);
	});

	test("an unparseable chat file skips the sweep, deleteChat still succeeds", () => {
		const { e, errs } = orphanThenDelete((e) => fs.writeFileSync(path.join(e.chatsDir, "bad.json"), "{not json"));
		assert.equal(casHashes(e.blobsFile).length, 2);
		assert.equal(errs.filter((m) => m.includes("sweep")).length, 1);
	});

	test("a chat file stamped newer than this build skips the sweep", () => {
		const { e, errs } = orphanThenDelete((e) => fs.writeFileSync(path.join(e.chatsDir, "future.json"), JSON.stringify({ id: "future", version: 9999, imageSnapshots: {} })));
		assert.equal(casHashes(e.blobsFile).length, 2);
		assert.equal(errs.filter((m) => m.includes("sweep")).length, 1);
	});

	test("a legacy inline entry counts as referenced; a missing blobs.sqlite is not created", () => {
		const e = mk();
		const a = e.store.createChat("a");
		const b = e.store.createChat("b");
		assert.equal(e.store.deleteChat(b.id), true);
		assert.equal(fs.existsSync(e.blobsFile), false);
		e.raw.put(pool(1));
		const [h] = imgOf(pool(1));
		const file = path.join(e.chatsDir, `${a.id}.json`);
		const rec = JSON.parse(fs.readFileSync(file, "utf8"));
		fs.writeFileSync(file, JSON.stringify({ ...rec, imageSnapshots: { [h]: { mimeType: "image/png", data: b64(pool(1)), width: 1, height: 1 } } }));
		const c = e.store.createChat("c");
		assert.equal(e.store.deleteChat(c.id), true);
		assert.deepEqual(casHashes(e.blobsFile), [h]);
	});
});
