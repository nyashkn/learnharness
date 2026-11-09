/**
 * smoke-doltlite: the packaged server's DoltLite addon opens, writes, commits and reopens a store (bead D2).
 *
 * Run after `node scripts/build-server.mjs`: `pnpm exec tsx scripts/smoke-doltlite.ts`.
 * It runs under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1), the runtime the packaged server uses,
 * and loads the addon from .next/standalone/node_modules, never from the repo's own node_modules.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");
const ADDON_DIR = path.join(STANDALONE, "node_modules", "@dolthub", "doltlite");

const fail = (why: string): never => {
	console.error(`[smoke-doltlite] FAIL: ${why}`);
	process.exit(1);
};

if (!fs.existsSync(STANDALONE)) fail(".next/standalone missing, run next build and build-server first");

// CommonJS child. TRAP: .next/standalone sits inside the repo, so a bare require rooted there walks up to the
// repo's own node_modules/@dolthub/doltlite and passes falsely. The inside-standalone assertion is the guard.
const CHILD = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [addonDir, standalone, dbFile] = process.argv.slice(1);
const fail = (why) => { console.error("child: " + why); process.exit(2); };
let resolved;
try { resolved = require.resolve(addonDir); } catch (e) { fail("addon not resolvable at " + addonDir + ": " + e.message); }
const real = fs.realpathSync(resolved);
const inside = path.relative(fs.realpathSync(standalone), real);
if (inside.startsWith("..") || path.isAbsolute(inside)) fail("addon resolved outside the standalone: " + real);
const { DatabaseSync } = require(addonDir);
const open = () => new DatabaseSync(dbFile);
let db = open();
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(1, "hello");
const hash = db.doltCommit("smoke commit");
db.close();
db = open();
const row = db.prepare("SELECT v FROM t WHERE id = 1").get();
if (!row || row.v !== "hello") fail("row did not survive reopen: " + JSON.stringify(row));
const log = db.doltLog({ limit: 5 });
if (!log.some((c) => c.commit_hash === hash && c.message === "smoke commit")) fail("commit " + hash + " missing from the log after reopen");
db.close();
console.log(real);
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-doltlite-"));
try {
	const electron = createRequire(import.meta.url)("electron") as string;
	const run = spawnSync(electron, ["-e", CHILD, ADDON_DIR, STANDALONE, path.join(tmp, "smoke.db")], {
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		encoding: "utf8",
		timeout: 60_000,
	});
	if (run.status !== 0) {
		const noise = /^\s*(at |\^|$)|^Node\.js v|^Thrown at/;
		const line = (run.stderr || run.stdout || run.error?.message || "").split("\n").filter((l) => !noise.test(l)).find((l) => /^(Error|child:)/.test(l))?.trim() ?? "no output";
		fail(`${line} (exit ${run.status ?? run.signal})`);
	}
	const resolved = run.stdout.trim().split("\n").pop() ?? "";
	console.log(`[smoke-doltlite] ok: opened, wrote, committed, reopened and read back via ${path.relative(ROOT, resolved)}`);
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
