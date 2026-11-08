/**
 * GraphStore.transact on the file adapter (lh-7lz, contract items 4, 11, 14-17).
 * Model-based: a plain array stands in for the node ledger; the adapter must
 * agree with it inside the transaction (read-your-writes), on disk after
 * commit (call order), and leave disk byte-identical after a throw.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import fc from "fast-check";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-transact-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { LEDGER_FILES, SOURCES_FILE } = await import("../config.ts");
const { graphStore } = await import("../src/store/graph.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const node = (id: string) => ({ id, name: id, statement: `s ${id}`, aliases: [], createdAt: "2026-01-01T00:00:00Z", provenance: [] });
const bytes = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null);
const ids = () => graphStore.readNodes().map((n) => n.id);
const source = (id: string) => ({ id, filePath: `/x/${id}.md`, importedAt: "2026-01-01T00:00:00Z" });

type Cmd = { t: "append"; id: string } | { t: "rewrite"; keep: boolean[] } | { t: "read" };
const cmdArb = fc.oneof(
	fc.record({ t: fc.constant("append" as const), id: fc.stringMatching(/^n[0-9]{1,3}$/) }),
	fc.record({ t: fc.constant("rewrite" as const), keep: fc.array(fc.boolean(), { maxLength: 12 }) }),
	fc.record({ t: fc.constant("read" as const) }),
) as fc.Arbitrary<Cmd>;

/** Apply cmds to the store AND the model; check reads agree as we go. */
function run(cmds: Cmd[], model: string[]): string[] {
	for (const c of cmds) {
		if (c.t === "append") { graphStore.appendNode(node(c.id)); model.push(c.id); }
		else if (c.t === "rewrite") {
			const kept = model.filter((_, i) => c.keep[i] ?? true);
			graphStore.rewriteLedgers({ nodes: kept.map(node) });
			model = kept;
		}
		assert.deepEqual(ids(), model, `after ${JSON.stringify(c)}`);
	}
	return model;
}

beforeEach(() => {
	for (const f of [...Object.values(LEDGER_FILES), SOURCES_FILE]) fs.rmSync(f, { force: true });
});

describe("GraphStore.transact (file adapter)", () => {
	it("model: reads see disk + pending ops, and commit keeps call order", () => {
		fc.assert(
			fc.property(fc.array(fc.stringMatching(/^d[0-9]{1,3}$/), { maxLength: 6 }), fc.array(cmdArb, { maxLength: 25 }), (seed, cmds) => {
				graphStore.rewriteLedgers({ nodes: seed.map(node) });
				let final: string[] = [];
				graphStore.transact("t", () => {
					final = run(cmds, [...seed]);
				});
				assert.deepEqual(ids(), final, "after commit disk equals the model");
				const lines = (bytes(LEDGER_FILES.nodes) ?? "").split("\n").filter(Boolean);
				assert.deepEqual(lines.map((l) => (JSON.parse(l) as { id: string }).id), final);
			}),
			{ numRuns: 150 },
		);
	});

	it("nothing reaches disk before commit", () => {
		graphStore.appendNode(node("a"));
		const before = bytes(LEDGER_FILES.nodes);
		graphStore.transact("t", () => {
			graphStore.appendNode(node("b"));
			assert.deepEqual(ids(), ["a", "b"]);
			assert.equal(bytes(LEDGER_FILES.nodes), before);
		});
		assert.deepEqual(ids(), ["a", "b"]);
	});

	it("a throw leaves no trace (property)", () => {
		fc.assert(
			fc.property(fc.array(cmdArb, { maxLength: 20 }), fc.array(fc.stringMatching(/^s[0-9]{1,2}$/), { maxLength: 3 }), (cmds, srcIds) => {
				graphStore.rewriteLedgers({ nodes: [node("keep")] });
				for (const id of srcIds) graphStore.upsertSource(source(id));
				const before = [bytes(LEDGER_FILES.nodes), bytes(SOURCES_FILE)];
				assert.throws(() => graphStore.transact("t", () => {
					run(cmds, ["keep"]);
					graphStore.upsertSource(source("new"));
					graphStore.deleteSources(new Set(srcIds));
					throw new Error("boom");
				}), /boom/);
				assert.deepEqual([bytes(LEDGER_FILES.nodes), bytes(SOURCES_FILE)], before);
			}),
			{ numRuns: 60 },
		);
	});

	it("an async fn rolls back and throws", async () => {
		assert.throws(() => graphStore.transact("t", (() => {
			graphStore.appendNode(node("x"));
			return Promise.reject(new Error("late")); // also proves no unhandled rejection
		}) as () => unknown), /synchronous/);
		assert.deepEqual(ids(), []);
		await new Promise((r) => setImmediate(r));
	});

	it("a nested transact joins the outer one (one flush, outer throw undoes both)", () => {
		graphStore.transact("outer", () => {
			graphStore.appendNode(node("a"));
			graphStore.transact("inner", () => {
				assert.deepEqual(ids(), ["a"]);
				graphStore.appendNode(node("b"));
			});
			assert.deepEqual(ids(), ["a", "b"]);
		});
		assert.deepEqual(ids(), ["a", "b"]);
		assert.throws(() => graphStore.transact("outer", () => {
			graphStore.transact("inner", () => graphStore.appendNode(node("c")));
			throw new Error("boom");
		}));
		assert.deepEqual(ids(), ["a", "b"]);
	});

	it("a caught inner throw still rolls the outer back", () => {
		assert.throws(() => graphStore.transact("outer", () => {
			graphStore.appendNode(node("a"));
			try {
				graphStore.transact("inner", () => { throw new Error("inner"); });
			} catch { /* swallowed on purpose */ }
		}), /nested transact threw/);
		assert.deepEqual(ids(), []);
	});

	it("the transaction state is cleared after a failure", () => {
		assert.throws(() => graphStore.transact("t", () => { throw new Error("x"); }));
		graphStore.appendNode(node("direct")); // bare append hits disk again
		assert.ok(bytes(LEDGER_FILES.nodes)?.includes("direct"));
	});

	it("bare source writes work on their own and inside one transact", () => {
		graphStore.upsertSource(source("s1"));
		graphStore.appendSourceUsage("s1", { startedAt: "t1" } as never);
		graphStore.appendSourceUsage("s1", { startedAt: "t1" } as never); // idempotent
		assert.equal(graphStore.readSources()[0]!.extractions?.length, 1);
		graphStore.transact("t", () => {
			graphStore.upsertSource(source("s2"));
			assert.deepEqual(graphStore.readSources().map((s) => s.id).sort(), ["s1", "s2"]);
			assert.equal(graphStore.deleteSources(new Set(["s1", "zzz"])), 1);
			assert.deepEqual(graphStore.readSources().map((s) => s.id), ["s2"]);
			assert.equal(JSON.parse(bytes(SOURCES_FILE)!)["s1"].id, "s1", "disk untouched until commit");
		});
		assert.deepEqual(graphStore.readSources().map((s) => s.id), ["s2"]);
		assert.equal(graphStore.deleteSources(new Set(["nope"])), 0);
	});

	it("mutating a returned record does not leak into the pending log", () => {
		graphStore.transact("t", () => {
			graphStore.appendNode(node("a"));
			graphStore.readNodes()[0]!.name = "hacked";
			assert.equal(graphStore.readNodes()[0]!.name, "a");
		});
	});
});
