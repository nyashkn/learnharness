// Generator for rungs, adapters and contract files (architecture R2, R6; guardrails principle 4).
// Every refusal happens before the first write. Only the lock entry for the rung named is written: rehashing
// other rungs would launder a hand edit of a released rung.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { openNodeSqlite } from "../src/store/sql/drivers/node-sqlite.ts";
import { migrate, schemaDump } from "../src/store/sql/migrate.ts";
import type { Rung } from "../src/store/sql/rung.ts";

export interface Io {
	out(line: string): void;
	err(line: string): void;
}

class Refusal extends Error {}

const USAGE = "usage: new rung <name> [kind] | new adapter <name> <Port> | new contract <name>";
const RUNG_NAME = /^[a-z][a-z0-9_]*$/;
const NAME = /^[a-z][a-z0-9-]*$/;
const RUNG_FILE = /^\d{4}_.+\.ts$/;
const MIG = "src/store/sql/migrations";
const LOCK = `${MIG}/migrations.lock.json`;
const ARRAY_LINE = /^export const \w+Rungs: readonly Rung\[\] = \[([^\]]*)\];$/;
const IMPORT_LINE = /^import (rung\d+) from "\.\/(\d{4}_[^"]+)";$/;
/** Port -> StoreBundle key (tests/contract/harness.ts). */
const PORTS = new Map([
	["GraphStore", "graph"],
	["ChatStore", "chats"],
	["JobStore", "jobs"],
	["SettingsStore", "settings"],
	["SourceOrganizationStore", "sourceOrg"],
	["PromptOverrideStore", "prompts"],
	["AuthStore", "auth"],
]);

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const pascal = (s: string) => s.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");

export async function runNew(argv: string[], root: string, io: Io): Promise<number> {
	const args = argv.filter((a) => a !== "--");
	try {
		const [cmd, ...rest] = args;
		if (cmd === "rung") await rung(rest, root, io);
		else if (cmd === "adapter") adapter(rest, root, io);
		else if (cmd === "contract") contract(rest, root, io);
		else throw new Refusal(USAGE);
		return 0;
	} catch (error) {
		io.err(error instanceof Refusal ? error.message : `new: ${(error as Error).message}`);
		return 1;
	}
}

// ---- rung ----------------------------------------------------------------------------------------

async function rung(args: string[], root: string, io: Io): Promise<void> {
	const [name, kind = "graph", ...extra] = args;
	if (name === undefined || extra.length > 0) throw new Refusal(USAGE);
	if (!RUNG_NAME.test(name)) throw new Refusal(`rung name must match ${RUNG_NAME.source}: ${JSON.stringify(name)}`);
	const migrations = path.join(root, MIG);
	const kinds = fs.readdirSync(migrations, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
	if (!kinds.includes(kind) || !fs.existsSync(path.join(migrations, kind, "index.ts"))) {
		throw new Refusal(`unknown kind ${JSON.stringify(kind)}; kinds: ${kinds.join(", ")}`);
	}
	const dir = path.join(migrations, kind);
	const indexFile = path.join(dir, "index.ts");
	const lockFile = path.join(root, LOCK);
	const rungFiles = fs.readdirSync(dir).filter((f) => RUNG_FILE.test(f)).sort();
	const existing = rungFiles.find((f) => f.slice(5) === `${name}.ts`);
	const top0 = rungFiles.length ? Number(rungFiles[rungFiles.length - 1]!.slice(0, 4)) : 0;
	const version = existing ? Number(existing.slice(0, 4)) : top0 + 1;
	const file = existing ?? `${String(version).padStart(4, "0")}_${name}.ts`;
	const key = `${kind}/${file}`;
	if (existing && Object.hasOwn(releasedLock(root), key)) {
		throw new Refusal(`${key} is released (in origin/main's lock): add a new rung instead of refreshing it`);
	}
	const indexText = fs.readFileSync(indexFile, "utf8");
	const newIndex = addToIndex(indexText, version, file);
	const workingLock: Record<string, string> = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, "utf8")) : {};

	const rungPath = path.join(dir, file);
	const fresh = existing === undefined;
	const source = rungSource(version, name, kind);
	workingLock[key] = sha(fresh ? source : fs.readFileSync(rungPath));

	if (fresh) fs.writeFileSync(rungPath, source, { flag: "wx" });
	let dumps: string[];
	try {
		const rungs = await loadRungs(dir);
		dumps = shapes(kind, rungs, version);
	} catch (error) {
		if (fresh) fs.rmSync(rungPath, { force: true });
		throw new Refusal(`rung ${key} does not migrate: ${(error as Error).message}`);
	}

	// All outputs are computed; the writes below cannot fail on content.
	if (newIndex !== indexText) fs.writeFileSync(indexFile, newIndex);
	if (fs.existsSync(path.join(dir, "snapshot.sql"))) {
		fs.mkdirSync(path.join(dir, "shapes"), { recursive: true });
		dumps.forEach((d, i) => fs.writeFileSync(path.join(dir, "shapes", `v${version + i}.sql`), d));
		fs.writeFileSync(path.join(dir, "snapshot.sql"), dumps[dumps.length - 1]!);
	}
	const sorted = Object.fromEntries(Object.keys(workingLock).sort().map((k) => [k, workingLock[k]!]));
	fs.writeFileSync(lockFile, `${JSON.stringify(sorted, null, "\t")}\n`);
	io.out(`${fresh ? "created" : "refreshed"} ${key} (v${version})`);
}

/** Throws a Refusal unless index.ts has the expected shape; returns it with the rung imported and listed. */
function addToIndex(text: string, n: number, file: string): string {
	const lines = text.split("\n");
	const arrays = lines.flatMap((l, i) => (ARRAY_LINE.test(l) ? [i] : []));
	if (arrays.length !== 1) throw new Refusal("index.ts: expected one `export const <kind>Rungs: readonly Rung[] = [...];` line");
	const arrayIdx = arrays[0]!;
	const items = ARRAY_LINE.exec(lines[arrayIdx]!)![1]!.split(",").map((s) => s.trim()).filter(Boolean);
	const imports = lines.flatMap((l, i) => {
		const m = IMPORT_LINE.exec(l);
		return m ? [{ i, id: m[1]!, file: m[2]! }] : [];
	});
	if (imports.length === 0 || imports.map((m) => m.id).join(",") !== items.join(",")) {
		throw new Refusal("index.ts: the rung imports and the Rungs array do not match the expected shape");
	}
	const id = `rung${n}`;
	const have = imports.find((m) => m.id === id);
	if (have) {
		if (have.file !== file.replace(/\.ts$/, "")) throw new Refusal(`index.ts already imports ${id} from ${have.file}`);
		return text;
	}
	lines[arrayIdx] = lines[arrayIdx]!.replace(/\[([^\]]*)\];$/, `[${[...items, id].join(", ")}];`);
	lines.splice(imports[imports.length - 1]!.i + 1, 0, `import ${id} from "./${file.replace(/\.ts$/, "")}";`);
	return lines.join("\n");
}

function rungSource(n: number, name: string, kind: string): string {
	return [
		'import type { Rung } from "../../rung";',
		"",
		`/** TODO: say what this rung adds. Additive only. After editing, rerun \`pnpm run new -- rung ${name} ${kind}\` to refresh the snapshot and lock. */`,
		"export default {",
		`\tversion: ${n},`,
		`\tname: "${name}",`,
		"\tup: (db) =>",
		"\t\tdb.exec(`",
		"-- additive SQL here",
		"`),",
		"} satisfies Rung;",
		"",
	].join("\n");
}

/** Dynamic import per file (not index.ts, which pulls deps absent in a temp dir). The query makes each run read current bytes. */
async function loadRungs(dir: string): Promise<Rung[]> {
	const files = fs.readdirSync(dir).filter((f) => RUNG_FILE.test(f)).sort();
	const out: Rung[] = [];
	for (const f of files) {
		const url = `${pathToFileURL(path.join(dir, f)).href}?rev=${randomUUID()}`;
		out.push(((await import(url)) as { default: Rung }).default);
	}
	return out;
}

/** Schema dump after each rung from `from` to the top; element i is shape v(from + i). */
function shapes(kind: string, rungs: Rung[], from: number): string[] {
	return rungs.slice(from - 1).map((_, i) => {
		const db = openNodeSqlite(":memory:");
		try {
			migrate(db, { kind, rungs: rungs.slice(0, from + i), lhVersion: "generator" });
			return schemaDump(db);
		} finally {
			db.close();
		}
	});
}

/** The lock as released: origin/main's copy. Empty only when the ref exists and the file is not in it. */
function releasedLock(root: string): Record<string, string> {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	try {
		git("rev-parse", "--verify", "--quiet", "refs/remotes/origin/main");
	} catch {
		throw new Refusal("refs/remotes/origin/main is missing; run `git fetch origin main` so the released rungs are known");
	}
	try {
		git("cat-file", "-e", `refs/remotes/origin/main:${LOCK}`);
	} catch {
		return {};
	}
	return JSON.parse(git("show", `refs/remotes/origin/main:${LOCK}`)) as Record<string, string>;
}

// ---- adapter -------------------------------------------------------------------------------------

function adapter(args: string[], root: string, io: Io): void {
	const [name, port, ...extra] = args;
	if (name === undefined || port === undefined || extra.length > 0) throw new Refusal(USAGE);
	if (!NAME.test(name)) throw new Refusal(`adapter name must match ${NAME.source}: ${JSON.stringify(name)}`);
	const key = PORTS.get(port);
	if (key === undefined) throw new Refusal(`port must be one of: ${[...PORTS.keys()].join(", ")}`);
	const members = portMembers(root, port);
	const factory = `create${pascal(name)}Store`;
	const storeRel = `src/store/${name}-store.ts`;
	const regRel = `tests/contract/adapters/${name}.ts`;
	for (const rel of [storeRel, regRel]) {
		if (fs.existsSync(path.join(root, rel))) throw new Refusal(`${rel} exists; refusing to overwrite`);
	}
	const bt = "`";
	const store = [
		`import type { ${port} } from "../core/ports";`,
		"",
		`/** ${name} adapter for ${port}. Fill in each method; tsc fails here when the port gains one. */`,
		`export function ${factory}(dir: string) {`,
		"\tconst todo = (method: string) => (): never => {",
		`\t\tthrow new Error(${bt}${name} ${port}.\${method} is not implemented (data folder \${dir})${bt});`,
		"\t};",
		"\treturn {",
		...members.map((m) => `\t\t${m}: todo("${m}"),`),
		`\t} satisfies ${port};`,
		"}",
		"",
	].join("\n");
	const registration = [
		`/** Contract registration for the ${name} adapter. Found by glob; fails the contract suite until the adapter is implemented. */`,
		`import { ${factory} } from "../../../src/store/${name}-store.ts";`,
		'import type { AdapterFactory, StoreBundle } from "../harness.ts";',
		'import fileFactory from "./file.ts";',
		"",
		"const factory: AdapterFactory = {",
		`\tname: "${name}",`,
		"\tcapabilities: fileFactory.capabilities, // check each one against the real adapter",
		"\tasync open(dir): Promise<StoreBundle> {",
		`\t\treturn { ...(await fileFactory.open(dir)), ${key}: ${factory}(dir) };`,
		"\t},",
		"};",
		"export default factory;",
		"",
	].join("\n");
	fs.writeFileSync(path.join(root, storeRel), store, { flag: "wx" });
	fs.writeFileSync(path.join(root, regRel), registration, { flag: "wx" });
	io.out(`created ${storeRel} and ${regRel}`);
}

/** Member names of an interface in src/core/ports.ts, read with the TypeScript API. */
function portMembers(root: string, port: string): string[] {
	const file = path.join(root, "src/core/ports.ts");
	const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const iface = sf.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === port);
	if (!iface) throw new Refusal(`${port} is not an interface in src/core/ports.ts`);
	return iface.members.flatMap((m) => (m.name ? [m.name.getText(sf)] : []));
}

// ---- contract ------------------------------------------------------------------------------------

function contract(args: string[], root: string, io: Io): void {
	const [name, ...extra] = args;
	if (name === undefined || extra.length > 0) throw new Refusal(USAGE);
	if (!NAME.test(name)) throw new Refusal(`contract name must match ${NAME.source}: ${JSON.stringify(name)}`);
	const rel = `tests/contract/${name}.contract.ts`;
	const text = [
		'import assert from "node:assert/strict";',
		'import { describe, it } from "node:test";',
		'import { discoverAdapters, openFresh } from "./harness.ts";',
		"",
		"for (const f of await discoverAdapters()) {",
		"\tdescribe(`" + name + ": ${f.name}`, () => {",
		`\t\tit("${name}-1 TODO: name the property", async () => {`,
		"\t\t\tconst b = await openFresh(f);",
		"\t\t\ttry {",
		'\t\t\t\tassert.fail("write this property");',
		"\t\t\t} finally {",
		"\t\t\t\tb.dispose();",
		"\t\t\t}",
		"\t\t});",
		"\t});",
		"}",
		"",
	].join("\n");
	fs.writeFileSync(path.join(root, rel), text, { flag: "wx" });
	io.out(`created ${rel}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await runNew(process.argv.slice(2), process.cwd(), { out: (l) => console.log(l), err: (l) => console.error(l) });
}
