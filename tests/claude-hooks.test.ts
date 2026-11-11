/**
 * The PreToolUse hook in .claude/settings.json (lh-1rp): an Edit/Write on a generated snapshot.sql is denied (exit 2).
 * Runs the hook command exactly as settings.json holds it, against a temp project dir (no git, no files touched).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import fc from "fast-check";

const REPO = path.resolve(import.meta.dirname, "..");
const settings = JSON.parse(fs.readFileSync(path.join(REPO, ".claude/settings.json"), "utf8"));
const command: string = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === "Edit|Write").hooks[0].command;
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "lh-hook-"));
after(() => fs.rmSync(proj, { recursive: true, force: true }));

function hook(filePath: string): number | null {
	const r = spawnSync("/bin/sh", ["-c", command], {
		input: JSON.stringify({ tool_input: { file_path: filePath } }),
		env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
		encoding: "utf8",
	});
	return r.status;
}

const segment = fc.stringMatching(/^[a-z0-9_-]{1,8}$/);

describe("PreToolUse hook: generated snapshot.sql", () => {
	it("denies the real graph snapshot, relative and absolute", () => {
		assert.equal(hook("src/store/sql/migrations/graph/snapshot.sql"), 2);
		assert.equal(hook(path.join(proj, "src/store/sql/migrations/graph/snapshot.sql")), 2);
		assert.equal(hook("schema/graph/snapshot.sql"), 2);
	});

	it("denies snapshot.sql at any depth under the migrations dir", () => {
		fc.assert(
			fc.property(fc.array(segment, { maxLength: 3 }), (dirs) => hook(["src/store/sql/migrations", ...dirs, "snapshot.sql"].join("/")) === 2),
			{ numRuns: 15 },
		);
	});

	it("allows other files, including look-alike names", () => {
		for (const f of ["src/store/chats.ts", "src/store/sql/migrations/graph/my-snapshot.sql", "src/store/sql/migrations/graph/snapshot.sql.bak", "docs/snapshot.sql"]) {
			assert.equal(hook(f), 0, f);
		}
	});
});
