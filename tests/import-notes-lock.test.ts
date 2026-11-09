/**
 * lh-znk: scripts/import-notes.ts takes the store lock at start, before any LLM work.
 * The test process holds the REAL lock on a temp folder; the script must exit non-zero naming us.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, it } from "node:test";
import { acquireStoreLock } from "../src/store/sql/lock.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-import-lock-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const repo = path.resolve(import.meta.dirname, "..");

it("import-notes refuses to start while another process holds the store lock, naming the holder", () => {
	const data = path.join(root, "data");
	const notes = path.join(root, "notes");
	fs.mkdirSync(data, { recursive: true });
	fs.mkdirSync(notes);
	fs.writeFileSync(path.join(notes, "a.md"), "# a note\nsome text\n");
	const lock = acquireStoreLock(path.join(data, "storage.json"));
	try {
		const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/import-notes.ts", notes], {
			cwd: repo, encoding: "utf8", timeout: 60000,
			env: { PATH: process.env.PATH, HOME: root, NODE_ENV: "test", LH_DATA_DIR: data, LH_AUTH_FILE: path.join(root, "auth.json") },
		});
		assert.notEqual(r.status, 0, `expected a non-zero exit, got ${r.status}\n${r.stdout}\n${r.stderr}`);
		assert.match(r.stderr, new RegExp(`held by pid ${process.pid} `), r.stderr);
		assert.ok(!r.stdout.includes("note files"), "the script got past the lock and began work");
	} finally {
		lock.release();
	}
});
