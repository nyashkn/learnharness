/**
 * Each call-site wrapper around GraphStore.transact (lh-7lz) is guarded by a
 * throw at the LAST step of its work, against the real file adapter: without
 * the wrapper the earlier steps are already on disk, with it nothing is.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-transact-sites-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const { LEDGER_FILES, SOURCES_FILE } = await import("../config.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { mergeFindings } = await import("../src/core/graph.ts");
const { deleteSourcesTraces, deleteNodeTraces } = await import("../src/core/graph-deletion.ts");
const { stores } = await import("../src/server/stores.ts");
const { deleteSources } = await import("../src/server/source-deletion.ts");
import type { GraphStore } from "../src/core/ports.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const files = [...Object.values(LEDGER_FILES), SOURCES_FILE];
const snapshot = () => files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : null));
const node = (id: string, chatId: string) => ({ id, name: id, statement: id, aliases: [], createdAt: "2026-01-01T00:00:00Z", provenance: [{ chatId, messageId: "m" }] });
const chain = (id: string, chatId: string) => ({ id, premises: ["n_a"], conclusion: "n_b", createdAt: "2026-01-01T00:00:00Z", provenance: [{ chatId, messageId: "" }] });
/** The real adapter, except `method` throws when called. */
const failing = (method: keyof GraphStore): GraphStore => ({ ...graphStore, [method]: () => { throw new Error(`boom:${method}`); } });

beforeEach(() => {
	for (const f of files) fs.rmSync(f, { force: true });
	graphStore.rewriteLedgers({ nodes: [node("n_a", "chatA"), node("n_b", "chatA"), node("n_keep", "chatB")], chains: [chain("arg_1", "chatA")], coverage: [], checkpoints: [] });
	graphStore.appendCoverage({ chatId: "chatA", fp: "x", tokens: 1, foldedAt: "t" });
});

describe("call-site wrappers roll back when the last step throws", () => {
	it("mergeFindings (last step: the checkpoint/coverage append)", () => {
		const before = snapshot();
		const findings = { propositions: [{ id: "p1", name: "N", statement: "S", aliases: [] }], chains: [] };
		assert.throws(
			() => mergeFindings("chatC", findings, { links: [] }, { chatStore: stores.chatStore, graphStore: failing("appendCheckpoint") }, { foldedAt: "t" }),
			/boom:appendCheckpoint/,
		);
		assert.deepEqual(snapshot(), before);
	});

	it("deleteSourcesTraces (last step: the positions read after the ledger rewrite)", () => {
		const before = snapshot();
		assert.throws(() => deleteSourcesTraces(failing("readPositions"), new Set(["chatA"]), "delete-nodes"), /boom:readPositions/);
		assert.deepEqual(snapshot(), before);
	});

	it("deleteNodeTraces (last step: the positions read after the ledger rewrite)", () => {
		const before = snapshot();
		assert.throws(() => deleteNodeTraces(failing("readPositions"), "n_a"), /boom:readPositions/);
		assert.deepEqual(snapshot(), before);
	});

	it("server deleteSources (last step: the sources.json delete after the trace purge)", () => {
		stores.graphStore.upsertSource({ id: "src_chatA", filePath: "a.md", importedAt: "t" });
		stores.graphStore.rewriteLedgers({ nodes: [node("n_a", "src_chatA")] });
		const before = snapshot();
		const real = stores.graphStore.deleteSources;
		stores.graphStore.deleteSources = () => { throw new Error("boom:deleteSources"); };
		try {
			assert.throws(() => deleteSources({ sourceIds: ["src_chatA"], folderIds: [], deleteSessions: false }), /boom:deleteSources/);
		} finally { stores.graphStore.deleteSources = real; }
		assert.deepEqual(snapshot(), before);
	});
});

// Item 13 (lh-3d3): positions stay OUTSIDE the transaction. A rollback restores the ledgers but cannot restore a positions
// write made inside it, so the write happens after the commit and never when the transaction throws.
describe("deletion writes positions after the commit, never inside, never on a throw", () => {
	const START = { n_a: { x: 1, y: 1 }, n_b: { x: 2, y: 2 }, n_keep: { x: 3, y: 3 }, arg_1: { x: 4, y: 4 } };
	const cases: [string, (g: GraphStore) => unknown][] = [
		["deleteSourcesTraces", (g) => deleteSourcesTraces(g, new Set(["chatA"]), "delete-nodes")],
		["deleteNodeTraces (node)", (g) => deleteNodeTraces(g, "n_a")],
		["deleteNodeTraces (argument)", (g) => deleteNodeTraces(g, "arg_1")],
	];
	for (const [name, run] of cases) {
		it(`${name}: a throw at the end of the transaction leaves positions untouched`, () => {
			graphStore.writePositions(START);
			const store: GraphStore = { ...graphStore, transact: (label, fn) => graphStore.transact(label, () => { fn(); throw new Error("boom:late"); }) };
			assert.throws(() => run(store), /boom:late/);
			assert.deepEqual(graphStore.readPositions(), START);
		});
		it(`${name}: positions are written only once the transaction has committed`, () => {
			graphStore.writePositions(START);
			let committed = false;
			const writes: boolean[] = [];
			const store: GraphStore = {
				...graphStore,
				transact: (label, fn) => { const out = graphStore.transact(label, fn); committed = true; return out; },
				writePositions: (p) => { writes.push(committed); graphStore.writePositions(p); },
			};
			run(store);
			assert.deepEqual(writes, [true], "writePositions ran inside the transaction, or not exactly once");
			assert.notDeepEqual(graphStore.readPositions(), START, "dead positions were not pruned");
		});
	}
});
