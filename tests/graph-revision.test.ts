/**
 * GraphStore.revision() (lh-hbv): the fs mtime IS the counter. Guards the parts
 * contract N7 cannot reach: positions stay outside it, a same-tick or
 * future-dated file still moves it (never backwards), a torn tail keeps the next
 * append on its own line, and a newer-stamped folder refuses every mutator.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-revision-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { graphStore } = await import("../src/store/graph.ts");
const { StorageVersionError } = await import("../src/store/graph-format.ts");
const { LEDGER_FILES, GRAPH_FORMAT_FILE } = await import("../config.ts");

test.after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const node = (id: string) => ({ id, name: id, statement: id, aliases: [], createdAt: "t", provenance: [] });
const cov = (n: number) => ({ chatId: "c", fp: `f${n}`, tokens: 1, foldedAt: "t" });

test("revision: writePositions does not move it", () => {
	graphStore.appendNode(node("n0"));
	const r = graphStore.revision();
	graphStore.writePositions({ n0: { x: 1, y: 2 } });
	assert.equal(graphStore.revision(), r);
});

test("revision: a write into a future-dated ledger still moves it, and never backwards", () => {
	graphStore.appendNode(node("n1"));
	const future = new Date(Date.now() + 3_600_000);
	fs.utimesSync(LEDGER_FILES.nodes, future, future);
	let prev = graphStore.revision();
	assert.ok(prev >= future.getTime());
	for (let i = 2; i < 6; i++) {
		graphStore.appendNode(node(`n${i}`));
		const next = graphStore.revision();
		assert.ok(next > prev, `append ${i} left the revision at ${prev}`);
		prev = next;
	}
	// a rewrite and a bare source write ride the same stamp
	graphStore.rewriteLedgers({ nodes: [node("only")] });
	assert.ok(graphStore.revision() > prev);
	prev = graphStore.revision();
	graphStore.upsertSource({ id: "src_1", filePath: "/x", importedAt: "t" });
	assert.ok(graphStore.revision() > prev);
});

test("append after a torn tail starts on a new line, for every ledger", () => {
	const cases = [
		[LEDGER_FILES.nodes, (n: number) => graphStore.appendNode(node(`t${n}`)), () => graphStore.readNodes().length],
		[LEDGER_FILES.coverage, (n: number) => graphStore.appendCoverage(cov(n)), () => graphStore.readCoverage().length],
		[LEDGER_FILES.sessions, (n: number) => graphStore.appendCheckpoint({ chatId: `c${n}`, foldedAt: "t" }), () => graphStore.readCheckpoints().length],
		[LEDGER_FILES.chains, (n: number) => graphStore.appendChain({ id: `ch${n}`, premises: ["a"], conclusion: "b", provenance: [], createdAt: "t" }), () => graphStore.readChains().length],
	] as const;
	for (const [file, append, count] of cases) {
		fs.rmSync(file, { force: true });
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{"torn":'); // no newline
		append(1);
		assert.equal(count(), 1, `${path.basename(file)}: the new record was swallowed by the torn tail`);
		// the same through a transact flush
		fs.appendFileSync(file, '{"torn2":');
		graphStore.transact("tt", () => append(2));
		assert.equal(count(), 2, `${path.basename(file)}: the transact flush was swallowed`);
		assert.equal(fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.startsWith("{\"torn")).length, 2, "the fragments stay as their own lines");
	}
});

test("newer format: every mutator refuses with StorageVersionError and writes nothing", () => {
	fs.rmSync(LEDGER_FILES.nodes, { force: true });
	fs.writeFileSync(GRAPH_FORMAT_FILE, JSON.stringify({ version: 99 }));
	const before = graphStore.revision();
	const writes: Array<[string, () => unknown]> = [
		["appendNode", () => graphStore.appendNode(node("x"))],
		["appendChain", () => graphStore.appendChain({ id: "c", premises: ["a"], conclusion: "b", provenance: [], createdAt: "t" })],
		["appendCheckpoint", () => graphStore.appendCheckpoint({ chatId: "c", foldedAt: "t" })],
		["appendCoverage", () => graphStore.appendCoverage(cov(1))],
		["rewriteLedgers", () => graphStore.rewriteLedgers({ nodes: [] })],
		["upsertSource", () => graphStore.upsertSource({ id: "s", filePath: "/x", importedAt: "t" })],
		["deleteSources", () => graphStore.deleteSources(new Set(["s"]))],
		["appendSourceUsage", () => graphStore.appendSourceUsage("s", { startedAt: "t" } as never)],
		["transact(append)", () => graphStore.transact("n", () => graphStore.appendNode(node("y")))],
	];
	for (const [name, w] of writes) {
		assert.throws(w, (e: Error) => e instanceof StorageVersionError && e.name === "StorageVersionError" && e.found === 99 && /format version 99/.test(e.message), name);
	}
	assert.equal(graphStore.revision(), before);
	assert.ok(!fs.existsSync(LEDGER_FILES.nodes));
	fs.rmSync(GRAPH_FORMAT_FILE);
});
