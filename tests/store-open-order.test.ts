/**
 * lh-7km review items 5 and 6: the open (refusal) comes before anything touches the folder.
 * Expectations are written here: which files must survive, which must go.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { createFileStores } from "../src/store/file-stores.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-open-order-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const repo = path.resolve(import.meta.dirname, "..");
let n = 0;
const LEGACY = ["edges.jsonl", "events.jsonl"];

/** A folder holding both legacy ledgers; `stamp` makes it one this build must refuse (or not). */
function folder(stamp: (dir: string) => void): string {
	const dir = path.join(root, `d${n++}`);
	fs.mkdirSync(path.join(dir, "graph"), { recursive: true });
	for (const f of LEGACY) fs.writeFileSync(path.join(dir, "graph", f), '{"old":true}\n');
	stamp(dir);
	return dir;
}
const layout2 = (dir: string) => fs.writeFileSync(path.join(dir, "storage.json"), JSON.stringify({ backend: "file", layout: 2 }));
const newerFormat = (dir: string) => fs.writeFileSync(path.join(dir, "graph", "format.json"), JSON.stringify({ version: 999 }));
const ok = (dir: string) => fs.writeFileSync(path.join(dir, "storage.json"), JSON.stringify({ backend: "file", layout: 1 }));
const present = (dir: string) => LEGACY.map((f) => fs.existsSync(path.join(dir, "graph", f)));

describe("createFileStores purges legacy ledgers only after open succeeds", () => {
	for (const [name, stamp] of [["layout 2", layout2], ["newer graph format", newerFormat]] as const) {
		it(`${name}: refused, and both legacy files survive`, () => {
			const dir = folder(stamp);
			assert.throws(() => createFileStores(dir, path.join(root, "auth.json")), { name: "StorageVersionError" });
			assert.deepEqual(present(dir), [true, true]);
		});
	}
	it("an accepted folder is purged", () => {
		const dir = folder(ok);
		createFileStores(dir, path.join(root, "auth.json"));
		assert.deepEqual(present(dir), [false, false]);
	});
});

describe("the app composition root (src/server/stores.ts)", () => {
	const load = (dir: string) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `await import(${JSON.stringify(path.join(repo, "src/server/stores.ts"))});`], {
		cwd: repo, encoding: "utf8", timeout: 60000,
		env: { PATH: process.env.PATH, HOME: root, NODE_ENV: "test", LH_DATA_DIR: dir, LH_AUTH_FILE: path.join(root, "auth.json") },
	});

	it("refuses a layout 2 folder at module load with StorageVersionError, legacy files untouched", () => {
		const dir = folder(layout2);
		const r = load(dir);
		assert.notEqual(r.status, 0, r.stdout);
		assert.match(r.stderr, /StorageVersionError/);
		assert.deepEqual(present(dir), [true, true]);
	});
	it("a newer graph format is refused at load, legacy files untouched", () => {
		const dir = folder(newerFormat);
		const r = load(dir);
		assert.notEqual(r.status, 0, r.stdout);
		assert.match(r.stderr, /StorageVersionError/);
		assert.deepEqual(present(dir), [true, true]);
	});
	it("an accepted folder loads and is purged", () => {
		const dir = folder(ok);
		const r = load(dir);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(present(dir), [false, false]);
	});
});
