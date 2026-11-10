/**
 * `pnpm run new` (scripts/new.ts), MECE by failpoint. Every run works in a temp dir; this repo's files and refs are never
 * touched. Expected values are literals or computed here with createHash, never read back from the generator.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import fc from "fast-check";
import { type Io, runNew } from "../scripts/new.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const MIG = "src/store/sql/migrations";
const LOCK = `${MIG}/migrations.lock.json`;
const TSX = path.join(REPO, "node_modules/.bin/tsx");
const TSC = path.join(REPO, "node_modules/.bin/tsc");
const NEW = path.join(REPO, "scripts/new.ts");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

let tmp: string;
before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-new-"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A temp repo with the real migrations, committed, and origin/main pointing at it (what is released). */
function fixture(extra: string[] = []): string {
	const dir = fs.mkdtempSync(path.join(tmp, "f-"));
	fs.cpSync(path.join(REPO, MIG), path.join(dir, MIG), { recursive: true });
	for (const e of extra) fs.cpSync(path.join(REPO, e), path.join(dir, e), { recursive: true });
	git(dir, "init", "-q");
	git(dir, "add", "-A");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "released");
	git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
	return dir;
}

const lockOf = (dir: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(dir, LOCK), "utf8"));

function cli(cwd: string, ...args: string[]) {
	const r = spawnSync(TSX, [NEW, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

async function inProcess(cwd: string, args: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l) };
	return { code: await runNew(args, cwd, io), out, err };
}

/** Every file under dir, relative path -> base64 contents. */
function tree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out[path.relative(dir, p)] = fs.readFileSync(p, "base64");
		}
	};
	walk(dir);
	return out;
}

const indexOf = (dir: string, kind = "graph") => fs.readFileSync(path.join(dir, MIG, kind, "index.ts"), "utf8");
const exists = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));
/** The graph ladder's top version, read from the fixture's rung file names (the repo's real ladder grows). */
const graphTop = (dir: string) =>
	Math.max(...fs.readdirSync(path.join(dir, MIG, "graph")).flatMap((f) => /^(\d{4})_.+\.ts$/.exec(f)?.[1] ?? []).map(Number));
const pad = (v: number) => String(v).padStart(4, "0");

/** A rung file that does one literal statement. */
const rungWith = (version: number, name: string, sql: string) =>
	`import type { Rung } from "../../rung";\n\nexport default {\n\tversion: ${version},\n\tname: "${name}",\n\tup: (db) => db.exec(${JSON.stringify(sql)}),\n} satisfies Rung;\n`;

// ---- 1. rung ladder ----------------------------------------------------------------------------

describe("1: rung ladder", () => {
	const name = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/).filter((n) => n !== "init");

	it("fresh rungs stay dense, ordered in the index, additive in the lock, and listed in shapes/", async () => {
		await fc.assert(
			fc.asyncProperty(fc.uniqueArray(name, { minLength: 1, maxLength: 3 }), async (names) => {
				const dir = fixture();
				const prior = lockOf(dir);
				const start = graphTop(dir);
				const top = start + names.length;
				const ids: string[] = [];
				for (const [i, n] of names.entries()) {
					const r = await inProcess(dir, ["rung", n]);
					assert.equal(r.code, 0, r.err.join("\n"));
					const version = start + 1 + i;
					const base = `${pad(version)}_${n}`;
					ids.push(`rung${version}`);
					assert.ok(exists(dir, `${MIG}/graph/${base}.ts`));
					assert.ok(indexOf(dir).includes(`import rung${version} from "./${base}";`));
				}
				assert.ok(indexOf(dir).includes(`export const graphRungs: readonly Rung[] = [${[...Array.from({ length: start }, (_, i) => `rung${i + 1}`), ...ids].join(", ")}];`));
				const lock = lockOf(dir);
				assert.deepEqual(Object.keys(lock).sort(), [...Object.keys(prior), ...names.map((_, i) => `graph/${pad(start + 1 + i)}_${names[i]}.ts`)].sort());
				for (const k of Object.keys(prior)) assert.equal(lock[k], prior[k], `pre-existing ${k}`);
				for (const [i, n] of names.entries()) {
					const f = `${MIG}/graph/${pad(start + 1 + i)}_${n}.ts`;
					assert.equal(lock[`graph/${path.basename(f)}`], sha(fs.readFileSync(path.join(dir, f))));
				}
				const shapeFiles = fs.readdirSync(path.join(dir, MIG, "graph", "shapes")).sort();
				assert.deepEqual(shapeFiles, Array.from({ length: top }, (_, i) => `v${i + 1}.sql`));
			}),
			{ numRuns: 10 },
		);
	});
});

// ---- 2. snapshot ------------------------------------------------------------------------------

describe("2: snapshot", () => {
	it("a refreshed rung rewrites snapshot.sql, its shapes/v<N>.sql and its lock value", () => {
		const dir = fixture();
		const next = graphTop(dir) + 1;
		const original = fs.readFileSync(path.join(dir, MIG, "graph/snapshot.sql"), "utf8");
		assert.equal(cli(dir, "rung", "zed").code, 0);
		const rungFile = path.join(dir, MIG, `graph/${pad(next)}_zed.ts`);
		fs.writeFileSync(rungFile, rungWith(next, "zed", "CREATE TABLE zed (a TEXT)"));
		const r = cli(dir, "rung", "zed");
		assert.equal(r.code, 0, r.err);
		const snapshot = fs.readFileSync(path.join(dir, MIG, "graph/snapshot.sql"), "utf8");
		assert.ok(snapshot.includes("CREATE TABLE zed (a TEXT);\n"));
		for (const line of original.split("\n").filter(Boolean)) assert.ok(snapshot.includes(`${line}\n`), line);
		assert.equal(fs.readFileSync(path.join(dir, MIG, `graph/shapes/v${next}.sql`), "utf8"), snapshot);
		assert.equal(lockOf(dir)[`graph/${pad(next)}_zed.ts`], sha(fs.readFileSync(rungFile)));
	});
});

// ---- 3. laundering ----------------------------------------------------------------------------

describe("3: released rungs are not laundered", () => {
	it("a hand-edited released rung keeps its released lock value after a new rung is generated", () => {
		const dir = fixture();
		const released = lockOf(dir)["graph/0001_init.ts"];
		const rung1 = path.join(dir, MIG, "graph/0001_init.ts");
		fs.appendFileSync(rung1, "\n// hand edit\n");
		assert.equal(cli(dir, "rung", "foo").code, 0);
		assert.equal(lockOf(dir)["graph/0001_init.ts"], released);
		assert.notEqual(sha(fs.readFileSync(rung1)), released);
	});
});

// ---- 4. refresh refusals ----------------------------------------------------------------------

describe("4: refresh of released and unverifiable rungs", () => {
	it("refuses to refresh a released rung and changes nothing", () => {
		const dir = fixture();
		const before = tree(dir);
		const r = cli(dir, "rung", "init");
		assert.equal(r.code, 1);
		assert.match(r.err, /released/);
		assert.deepEqual(tree(dir), before);
	});

	it("refuses to refresh when origin/main is absent and changes nothing", () => {
		const dir = fixture();
		assert.equal(cli(dir, "rung", "zed").code, 0);
		git(dir, "update-ref", "-d", "refs/remotes/origin/main");
		const before = tree(dir);
		const r = cli(dir, "rung", "zed");
		assert.equal(r.code, 1);
		assert.match(r.err, /git fetch origin main/);
		assert.deepEqual(tree(dir), before);
	});

	it("allows refresh when origin/main exists but has no lock file", () => {
		const dir = fixture();
		assert.equal(cli(dir, "rung", "zed").code, 0);
		const emptyTree = execFileSync("git", ["mktree"], { cwd: dir, input: "", encoding: "utf8" }).trim();
		const commit = git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", emptyTree, "-m", "no lock").trim();
		git(dir, "update-ref", "refs/remotes/origin/main", commit);
		assert.equal(cli(dir, "rung", "zed").code, 0);
	});
});

// ---- 5. seeds kind ----------------------------------------------------------------------------

describe("5: seeds kind has no snapshot", () => {
	it("updates seeds/index.ts and the lock, creates no snapshot.sql or shapes/", () => {
		const dir = fixture();
		const graphBefore = tree(dir);
		const r = cli(dir, "rung", "extra", "seeds");
		assert.equal(r.code, 0, r.err);
		assert.ok(exists(dir, `${MIG}/seeds/0003_extra.ts`));
		assert.ok(indexOf(dir, "seeds").includes('import rung3 from "./0003_extra";'));
		assert.ok(indexOf(dir, "seeds").includes("export const seedRungs: readonly Rung[] = [rung1, rung2, rung3];"));
		assert.equal(lockOf(dir)["seeds/0003_extra.ts"], sha(fs.readFileSync(path.join(dir, MIG, "seeds/0003_extra.ts"))));
		assert.equal(exists(dir, `${MIG}/seeds/snapshot.sql`), false);
		assert.equal(exists(dir, `${MIG}/seeds/shapes`), false);
		for (const k of Object.keys(graphBefore).filter((k) => k.includes("/graph/"))) assert.equal(tree(dir)[k], graphBefore[k]);
	});
});

// ---- 6. failed generation leaves nothing behind -----------------------------------------------

describe("6: failed generation", () => {
	it("bad SQL on refresh exits 1 and leaves index, snapshot, shapes and lock unchanged", () => {
		const dir = fixture();
		const next = graphTop(dir) + 1;
		assert.equal(cli(dir, "rung", "zed").code, 0);
		const rungFile = `${MIG}/graph/${pad(next)}_zed.ts`;
		fs.writeFileSync(path.join(dir, rungFile), rungWith(next, "zed", "CREATE TABL zed (a TEXT)"));
		const before = tree(dir);
		const r = cli(dir, "rung", "zed");
		assert.equal(r.code, 1);
		const now = tree(dir);
		assert.deepEqual(now, { ...before, [rungFile]: now[rungFile] });
	});

	it("malformed index.ts on a fresh rung exits 1 and leaves no rung file", () => {
		const dir = fixture();
		fs.writeFileSync(path.join(dir, MIG, "graph/index.ts"), "export const graphRungs = [];\n");
		const before = tree(dir);
		const r = cli(dir, "rung", "foo");
		assert.equal(r.code, 1);
		assert.equal(exists(dir, `${MIG}/graph/${pad(graphTop(dir) + 1)}_foo.ts`), false);
		assert.deepEqual(tree(dir), before);
	});
});

// ---- 7. refusals ------------------------------------------------------------------------------

describe("7: refusals change nothing", () => {
	let dir: string;
	let pristine: Record<string, string> = {};
	const rel = (re: RegExp) => fc.string({ maxLength: 12 }).filter((s) => !re.test(s));
	const rungRe = /^[a-z][a-z0-9_]*$/;
	const adapterRe = /^[a-z][a-z0-9-]*$/;

	async function refused(args: string[]) {
		const r = await inProcess(dir, args);
		assert.equal(r.code, 1, args.join(" "));
		assert.ok(r.err.length > 0, args.join(" "));
		assert.deepEqual(tree(dir), pristine, args.join(" "));
	}

	it("bad names, unknown kinds and ports, and missing args are refused", async () => {
		dir = fixture();
		pristine = tree(dir);
		await fc.assert(
			fc.asyncProperty(rel(rungRe), async (n) => refused(["rung", n])),
			{ numRuns: 10 },
		);
		await fc.assert(
			fc.asyncProperty(rel(adapterRe), async (n) => refused(["contract", n])),
			{ numRuns: 10 },
		);
		await fc.assert(
			fc.asyncProperty(rel(adapterRe), async (n) => refused(["adapter", n, "AuthStore"])),
			{ numRuns: 10 },
		);
		for (const n of ["../evil", "a/b", "Upper", "1x", ""]) {
			await refused(["rung", n]);
			await refused(["contract", n]);
			await refused(["adapter", n, "AuthStore"]);
		}
		await refused(["rung", "zed", "nope"]);
		await refused(["rung", "zed", "../graph"]);
		await refused(["adapter", "acme", "RenderSettingsStore"]);
		await refused(["adapter", "acme", "Nope"]);
		await refused(["adapter", "acme"]);
		await refused(["rung"]);
		await refused(["contract"]);
		await refused([]);
		await refused(["rung", "zed", "graph", "extra"]);
	});
});

// ---- 8 and 10. adapter and contract, one fixture, one tsc run ----------------------------------

describe("8 and 10: generated adapter and contract typecheck", { timeout: 300_000 }, () => {
	let dir: string;
	let storeFile: string;
	let regFile: string;
	let contractFile: string;

	before(() => {
		dir = fixture(["src", "tests/contract"]);
		fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
		// Every tracked root entry, so an import out of src resolves as the tree grows. Files are copied to keep their relative imports in this tree.
		for (const e of git(REPO, "ls-tree", "--name-only", "HEAD").trim().split("\n")) {
			const [from, to] = [path.join(REPO, e), path.join(dir, e)];
			if (fs.existsSync(to)) continue;
			if (fs.statSync(from).isDirectory()) fs.symlinkSync(from, to, "dir");
			else fs.cpSync(from, to);
		}
		const r1 = cli(dir, "adapter", "acme", "AuthStore");
		assert.equal(r1.code, 0, r1.err);
		assert.equal(cli(dir, "contract", "acme").code, 0);
		storeFile = path.join(dir, "src/store/acme-store.ts");
		regFile = path.join(dir, "tests/contract/adapters/acme.ts");
		contractFile = path.join(dir, "tests/contract/acme.contract.ts");
		const tsconfig = (files: string[]) => JSON.stringify({ extends: path.join(REPO, "tsconfig.json"), compilerOptions: { incremental: false }, include: files });
		fs.writeFileSync(path.join(dir, "tsconfig.adapter.json"), tsconfig(["src/store/acme-store.ts", "tests/contract/adapters/acme.ts"]));
		fs.writeFileSync(path.join(dir, "tsconfig.contract.json"), tsconfig(["tests/contract/acme.contract.ts"]));
	});

	const tsc = (cfg: string) => spawnSync(TSC, ["--noEmit", "-p", path.join(dir, cfg)], { cwd: dir, encoding: "utf8" });

	it("8: adapter satisfies AuthStore, is registered by name, and typechecks", () => {
		const store = fs.readFileSync(storeFile, "utf8");
		assert.ok(store.includes("satisfies AuthStore"));
		for (const m of ["authVars", "setAuthVar", "deleteAuthVar", "readCustomAuth", "writeCustomAuth"]) {
			assert.ok(store.includes(`${m}: todo("${m}")`), m);
		}
		assert.ok(fs.readFileSync(regFile, "utf8").includes('name: "acme"'));
		const r = tsc("tsconfig.adapter.json");
		assert.equal(r.status, 0, r.stdout + r.stderr);
	});

	it("10: contract file exists and typechecks", () => {
		assert.ok(fs.existsSync(contractFile));
		const r = tsc("tsconfig.contract.json");
		assert.equal(r.status, 0, r.stdout + r.stderr);
	});

	it("8b: deleting a satisfies member fails tsc and names it", () => {
		const kept = fs.readFileSync(storeFile, "utf8").split("\n").filter((l) => !/^\t\tdeleteAuthVar:/.test(l));
		fs.writeFileSync(storeFile, kept.join("\n"));
		const r = tsc("tsconfig.adapter.json");
		assert.notEqual(r.status, 0);
		assert.match(r.stdout + r.stderr, /deleteAuthVar/);
	});
});

// ---- 9. existing targets ----------------------------------------------------------------------

describe("9: existing targets are never overwritten", () => {
	it("adapter and contract refuse an existing file, byte-identical afterwards", () => {
		const dir = fixture(["src/core", "tests/contract"]);
		fs.mkdirSync(path.join(dir, "src/store"), { recursive: true });
		assert.equal(cli(dir, "adapter", "acme", "AuthStore").code, 0);
		assert.equal(cli(dir, "contract", "acme").code, 0);
		const before = tree(dir);
		assert.equal(cli(dir, "adapter", "acme", "AuthStore").code, 1);
		assert.equal(cli(dir, "contract", "acme").code, 1);
		assert.deepEqual(tree(dir), before);
	});

	it("adapter refuses when only the registration exists, and writes no store file", () => {
		const dir = fixture();
		fs.mkdirSync(path.join(dir, "tests/contract/adapters"), { recursive: true });
		fs.writeFileSync(path.join(dir, "tests/contract/adapters/acme.ts"), "// mine\n");
		const r = cli(dir, "adapter", "acme", "AuthStore");
		assert.equal(r.code, 1);
		assert.equal(exists(dir, "src/store/acme-store.ts"), false);
	});
});
