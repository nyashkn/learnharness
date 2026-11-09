/**
 * Meta-test for tests/contract/FAILPOINTS.md (lh-o0a). Named *.contract.ts so `pnpm run test:contract` runs it
 * (tests/test-globs.test.ts rejects a tests/contract/*.test.ts: no gate glob matches it).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const here = import.meta.dirname;
const repo = path.resolve(here, "../..");

const CATEGORIES = [
	"crash-before", "crash-after", "crash-commit", "torn-tail", "throw-in-transact", "async-fn", "caught-inner-throw",
	"lock-contention-busy", "lock-contention-store", "stale-lock", "newer-version-open", "newer-version-write",
	"seal-failure-driver", "seal-failure-adapter", "disk-full", "corrupt-line", "rewrite-modified-copies",
	"sql-adapter-crash", "doltlite-crash",
];

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

/** test id -> declaring files. A declaration is P("ID", ..), T("ID", ..) or it("ID ..") in tests/contract (this file excluded) or tests/sql.
 *  Every id is also keyed `<repo-relative file>#<id>`, so a row can name one file's test when two files use the same id. */
function declaredIds(): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const add = (key: string, f: string) => out.set(key, [...(out.get(key) ?? []), f]);
	for (const f of [...walk(here), ...walk(path.join(repo, "tests", "sql"))].filter((x) => x.endsWith(".ts") && x !== import.meta.filename)) {
		for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:\b[PT]\(|\bit\()\s*["'`]([A-Za-z][A-Za-z0-9_-]*)/g)) {
			add(m[1]!, f);
			add(`${path.relative(repo, f)}#${m[1]!}`, f);
		}
	}
	return out;
}

interface Row { category: string; test: string; status: string }
const rows = (): Row[] => fs.readFileSync(path.join(here, "FAILPOINTS.md"), "utf8").split("\n")
	.filter((l) => l.startsWith("|") && !/^\|\s*(category|-)/.test(l))
	.map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
	.map(([category, , , test, status]) => ({ category: category!, test: test!, status: status! }));

describe("FAILPOINTS.md covers the suite", () => {
	it("FM1 the matrix lists exactly the required failpoints, each once", () => {
		const r = rows();
		const cats = r.map((x) => x.category);
		const dup = cats.filter((c, i) => cats.indexOf(c) !== i);
		assert.deepEqual(dup, [], `duplicated failpoint rows: ${dup}`);
		assert.deepEqual([...cats].sort(), [...CATEGORIES].sort(), "missing or unknown failpoint categories");
		const tests = r.map((x) => x.test);
		const dupTests = tests.filter((t, i) => tests.indexOf(t) !== i);
		assert.deepEqual(dupTests, [], `a test id is claimed by two rows: ${dupTests}`);
	});

	it("FM2 every row names a test id that exists in the suite", () => {
		const ids = declaredIds();
		const missing = rows().filter((r) => !ids.has(r.test)).map((r) => `${r.category} -> ${r.test}`);
		assert.deepEqual(missing, [], `rows without a test: ${missing.join("; ")}`);
	});

	it("FM3 a todo row names an owning bead that its declaring file carries; a test row is not a todo", () => {
		const ids = declaredIds();
		for (const r of rows()) {
			const m = /^todo:(lh-[a-z0-9]+)$/.exec(r.status);
			if (r.status === "test") continue;
			assert.ok(m, `${r.category}: status must be "test" or "todo:<bead>", got "${r.status}"`);
			const files = ids.get(r.test) ?? [];
			assert.ok(files.some((f) => fs.readFileSync(f, "utf8").includes(`todo: "${m[1]}"`)), `${r.category}: ${r.test} does not carry todo: "${m[1]}"`);
		}
	});

	it("FM4 the test-only faulty driver is never imported from production code", () => {
		const bad = walk(path.join(repo, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("drivers/faulty.ts") && /drivers\/faulty/.test(fs.readFileSync(f, "utf8")));
		assert.deepEqual(bad.map((f) => path.relative(repo, f)), []);
	});
});
