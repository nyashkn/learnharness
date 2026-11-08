import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;

const STORE_IMPORT = /\b(?:from|import)\s*\(?\s*["'](?:(?:\.\.\/)+|@\/src\/)store\/([^"']+)["']/g;

const leaksIn = (file: string, source: string) => [...source.matchAll(STORE_IMPORT)].map((m) => `${file} -> ${m[1]}`);

test("leaksIn finds every import form, one entry per line", () => {
	const source = [
		'import { a } from "../store/a.ts";',
		'export {\n\tb,\n} from "../store/b.ts";',
		'import { a as a2 } from "../store/a.ts";',
		'const c = await import("../store/c.ts");',
		'import { d } from "@/src/store/d.ts";',
		'import { e } from "../core/e.ts";',
	].join("\n");
	assert.deepEqual(leaksIn("f.ts", source), ["f.ts -> a.ts", "f.ts -> b.ts", "f.ts -> a.ts", "f.ts -> c.ts", "f.ts -> d.ts"]);
});

test("the allowlist is exactly the store imports that still leak, and it only shrinks", async () => {
	const url = new URL("../eslint/leak-allowlist.mjs", import.meta.url).href;
	const { leakAllowlist, maxLeaks } = (await import(url)) as { leakAllowlist: { file: string; module: string }[]; maxLeaks: number };
	const files = globSync(["src/server/**/*.ts", "src/server/**/*.tsx"], { cwd: root }).filter((file) => file !== "src/server/stores.ts");
	assert.ok(files.includes("src/server/index.ts"), "the file walk found nothing real");
	const actual = files.flatMap((file) => leaksIn(file, readFileSync(`${root}${file}`, "utf8"))).sort();
	assert.deepEqual(actual, leakAllowlist.map((leak) => `${leak.file} -> ${leak.module}`).sort());
	assert.ok(leakAllowlist.length <= maxLeaks, "new leaks are not allowed: route the import through src/server/stores.ts");
});
