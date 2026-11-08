import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const scripts: Record<string, string> = JSON.parse(readFileSync(`${root}package.json`, "utf8")).scripts;

/** Test-path tokens of the scripts `ci` actually runs, quotes kept. */
function ciTokens(all: Record<string, string>): string[] {
	const names = [...(all.ci ?? "").matchAll(/pnpm run ([\w:-]+)/g)].map((m) => m[1] as string);
	return names.flatMap((name) => [...(all[name] ?? "").matchAll(/"?tests\/[^\s"]+"?/g)].map((m) => m[0]));
}

const unquote = (token: string) => token.replaceAll('"', "");

const orphans = (files: string[], globs: string[]) => files.filter((file) => !globs.some((glob) => matchesGlob(file, glob)));

// sh expands an unquoted ** like *, which would silently skip files directly under the folder.
const flattenedByShell = (tokens: string[]) => tokens.filter((token) => token.includes("**") && !token.startsWith('"'));

test("orphans reports a test file no ci glob matches", () => {
	const globs = ["tests/*.test.ts", "tests/sql/**/*.test.ts"];
	const files = ["tests/a.test.ts", "tests/sql/b.test.ts", "tests/sql/deep/c.test.ts", "tests/seed/d.test.ts"];
	assert.deepEqual(orphans(files, globs), ["tests/seed/d.test.ts"]);
});

test("ciTokens only counts scripts reachable from ci", () => {
	const fake = { ci: "pnpm run a && pnpm run b", a: 'tsx --test "tests/a/**/*.test.ts"', b: "tsx --test tests/*.test.ts", c: "tsx --test tests/c/*.test.ts" };
	assert.deepEqual(ciTokens(fake), ['"tests/a/**/*.test.ts"', "tests/*.test.ts"]);
	assert.deepEqual(flattenedByShell(['"tests/a/**/*.test.ts"', "tests/b/**/*.test.ts"]), ["tests/b/**/*.test.ts"]);
});

test("every test file runs in the gate", () => {
	const tokens = ciTokens(scripts);
	assert.deepEqual(flattenedByShell(tokens), [], "quote ** globs in package.json so node expands them, not sh");
	const files = globSync(["tests/**/*.test.ts", "tests/**/*.test.tsx", "tests/**/*.contract.ts"], { cwd: root });
	assert.ok(files.includes("tests/test-globs.test.ts"), "the file walk found nothing real");
	assert.deepEqual(orphans(files, tokens.map(unquote)), []);
});
