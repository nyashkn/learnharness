/**
 * lh-bhc: the file adapter counts what it skips (architecture 2.1 items 2 and 12). Not on the GraphStore port (CB1): read by cast.
 * Expected counts come from a line model written here; the ledger bytes are built from the same model.
 */
import assert from "node:assert/strict";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createGraphStore, graphPaths } from "../src/store/graph.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-corrupt-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

const NODE = (id: string) => ({ id, name: id, statement: id, aliases: [], createdAt: "t", provenance: [] });
type Item = { k: "valid"; id: string } | { k: "bad"; text: string } | { k: "blank"; text: string };
const item: fc.Arbitrary<Item> = fc.oneof(
	fc.constantFrom("a", "b", "c").map((id): Item => ({ k: "valid", id })),
	fc.constantFrom("{", "not json", '{"id":1}', "[]", "null", "42", '{"id":"x"}', '"str"', '{"chatId":1}', '{"id":"n","name":"n","statement":"s","aliases":[1],"createdAt":"t","provenance":[]}').map((text): Item => ({ k: "bad", text })),
	fc.constantFrom("", "  ", "\t").map((text): Item => ({ k: "blank", text })),
);

function ledger(items: Item[], torn: string | null): { dir: string; text: string } {
	const dir = path.join(root, `d${n++}`);
	const g = graphPaths(path.join(dir, "graph"));
	fs.mkdirSync(path.dirname(g.nodes), { recursive: true });
	const lines = items.map((i) => (i.k === "valid" ? JSON.stringify(NODE(i.id)) : i.text));
	const text = (lines.length ? `${lines.join("\n")}\n` : "") + (torn ?? "");
	fs.writeFileSync(g.nodes, text);
	return { dir, text };
}
const corrupt = (dir: string): number => (createGraphStore(path.join(dir, "graph"), { dataDir: dir }) as unknown as { corruptLines(): number }).corruptLines();

describe("file adapter corruptLines()", () => {
	it("counts unparsable lines, schema failures, blank interior lines and a torn tail; the normal trailing newline is not a line", () => {
		fc.assert(fc.property(fc.array(item, { maxLength: 12 }), fc.constantFrom(null, '{"id":"n9","na', "{", "[1,", "  "), (items, torn) => {
			const { dir } = ledger(items, torn);
			const expected = items.filter((i) => i.k !== "valid").length + (torn === null ? 0 : 1);
			assert.equal(corrupt(dir), expected, JSON.stringify({ items, torn }));
			const store = createGraphStore(path.join(dir, "graph"), { dataDir: dir });
			assert.deepEqual(store.readNodes().map((x) => x.id), items.flatMap((i) => (i.k === "valid" ? [i.id] : [])), "the valid lines are still read, in order");
		}), { numRuns: 100, examples: [[[], null], [[{ k: "blank", text: "" }], null], [[{ k: "valid", id: "a" }], "{"]] });
	});

	it("counts across all four ledgers and is stateless (the same number twice, and after a read)", () => {
		const dir = path.join(root, `d${n++}`);
		const g = graphPaths(path.join(dir, "graph"));
		fs.mkdirSync(path.dirname(g.nodes), { recursive: true });
		for (const f of [g.nodes, g.chains, g.sessions, g.coverage]) fs.writeFileSync(f, `${JSON.stringify({ chatId: 1 })}\nnot json\n`);
		const store = createGraphStore(path.join(dir, "graph"), { dataDir: dir });
		assert.equal((store as unknown as { corruptLines(): number }).corruptLines(), 8);
		store.readNodes(); store.readChains();
		assert.equal((store as unknown as { corruptLines(): number }).corruptLines(), 8);
	});

	it("a clean, absent or empty ledger counts zero", () => {
		assert.equal(corrupt(path.join(root, "never-made")), 0);
		assert.equal(corrupt(ledger([], null).dir), 0);
		assert.equal(corrupt(ledger([{ k: "valid", id: "a" }, { k: "valid", id: "b" }], null).dir), 0);
	});
});
