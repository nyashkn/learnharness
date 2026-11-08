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
import { after, afterEach, beforeEach, describe, it } from "node:test";
import fc from "fast-check";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-transact-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { LEDGER_FILES, SOURCES_FILE } = await import("../config.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { sourceOrganizationStore } = await import("../src/store/source-organization.ts");
const { subscribe } = await import("../src/core/events.ts");
const { SOURCE_ORGANIZATION_FILE } = await import("../config.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const node = (id: string) => ({ id, name: id, statement: `s ${id}`, aliases: [], createdAt: "2026-01-01T00:00:00Z", provenance: [], premises: ["p"], conclusion: "c" });
const bytes = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null);
const ids = () => graphStore.readNodes().map((n) => n.id);
const source = (id: string) => ({ id, filePath: `/x/${id}.md`, importedAt: "2026-01-01T00:00:00Z" });

type Ledger = "nodes" | "chains";
type Cmd = { t: "append"; ledger: Ledger; id: string } | { t: "rewrite"; ledger: Ledger; keep: boolean[] } | { t: "read" };
const ledgerArb = fc.constantFrom<Ledger>("nodes", "chains");
const cmdArb = fc.oneof(
	fc.record({ t: fc.constant("append" as const), ledger: ledgerArb, id: fc.stringMatching(/^n[0-9]{1,3}$/) }),
	fc.record({ t: fc.constant("rewrite" as const), ledger: ledgerArb, keep: fc.array(fc.boolean(), { maxLength: 12 }) }),
	fc.record({ t: fc.constant("read" as const) }),
) as fc.Arbitrary<Cmd>;

// Both record kinds carry both shapes' fields, so each passes the OTHER ledger's
// shape guard: a read that leaks ops across ledgers cannot hide behind validation.
const chain = (id: string) => node(id);
const chainIds = () => graphStore.readChains().map((c) => c.id);
type Model = { nodes: string[]; chains: string[] };
const readBoth = (): Model => ({ nodes: ids(), chains: chainIds() });

/** Apply cmds to the store AND the model (two ledgers, so a read that leaks
 *  one ledger's ops into the other fails); check reads agree as we go. */
function run(cmds: Cmd[], model: Model): Model {
	const m: Model = { nodes: [...model.nodes], chains: [...model.chains] };
	for (const c of cmds) {
		if (c.t === "append") {
			if (c.ledger === "nodes") graphStore.appendNode(node(c.id)); else graphStore.appendChain(chain(c.id));
			m[c.ledger].push(c.id);
		} else if (c.t === "rewrite") {
			const kept = m[c.ledger].filter((_, i) => c.keep[i] ?? true);
			if (c.ledger === "nodes") graphStore.rewriteLedgers({ nodes: kept.map(node) }); else graphStore.rewriteLedgers({ chains: kept.map(chain) });
			m[c.ledger] = kept;
		}
		assert.deepEqual(readBoth(), m, `after ${JSON.stringify(c)}`);
	}
	return m;
}

beforeEach(() => {
	for (const f of [...Object.values(LEDGER_FILES), SOURCES_FILE, SOURCE_ORGANIZATION_FILE]) fs.rmSync(f, { force: true });
});

describe("GraphStore.transact (file adapter)", () => {
	it("model: reads see disk + pending ops, and commit keeps call order", () => {
		fc.assert(
			fc.property(fc.array(fc.stringMatching(/^d[0-9]{1,3}$/), { maxLength: 6 }), fc.array(cmdArb, { maxLength: 25 }), (seed, cmds) => {
				const start: Model = { nodes: seed, chains: seed.map((x) => `c${x}`) };
				graphStore.rewriteLedgers({ nodes: start.nodes.map(node), chains: start.chains.map(chain) });
				let final: Model = start;
				graphStore.transact("t", () => {
					final = run(cmds, start);
				});
				assert.deepEqual(readBoth(), final, "after commit disk equals the model");
				for (const [ledger, file] of [["nodes", LEDGER_FILES.nodes], ["chains", LEDGER_FILES.chains]] as const) {
					const lines = (bytes(file) ?? "").split("\n").filter(Boolean);
					assert.deepEqual(lines.map((l) => (JSON.parse(l) as { id: string }).id), final[ledger]);
				}
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
					run(cmds, { nodes: ["keep"], chains: [] });
					graphStore.upsertSource(source("new"));
					graphStore.deleteSources(new Set(srcIds));
					throw new Error("boom");
				}), /boom/);
				assert.deepEqual([bytes(LEDGER_FILES.nodes), bytes(SOURCES_FILE)], before);
			}),
			{ numRuns: 60 },
		);
	});

	it("a promise returned by fn is rolled back and rejected (work after an await is out of scope)", async () => {
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

	describe("source-organization writes join the transaction", () => {
		const org = (name: string) => ({ version: 1 as const, folders: [{ id: "f", name, parentId: null, createdAt: "now" }], placements: {} });
		let events = 0;
		let unsubscribe = () => {};
		beforeEach(() => { events = 0; unsubscribe = subscribe((e) => { if (e.type === "sources-changed") events++; }); });
		afterEach(() => unsubscribe());

		it("a throw leaves the file untouched and emits nothing", () => {
			sourceOrganizationStore.write(org("before"));
			events = 0;
			const before = bytes(SOURCE_ORGANIZATION_FILE);
			assert.throws(() => graphStore.transact("t", () => {
				sourceOrganizationStore.write(org("pending"));
				throw new Error("boom");
			}), /boom/);
			assert.equal(bytes(SOURCE_ORGANIZATION_FILE), before);
			assert.equal(events, 0);
		});

		it("reads replay the pending write; commit writes it and emits once", () => {
			sourceOrganizationStore.write(org("before"));
			events = 0;
			graphStore.transact("t", () => {
				sourceOrganizationStore.write(org("pending"));
				assert.equal(sourceOrganizationStore.read().folders[0]!.name, "pending");
				assert.match(bytes(SOURCE_ORGANIZATION_FILE)!, /before/, "disk untouched until commit");
				assert.equal(events, 0, "no event inside the transaction");
				graphStore.appendNode(node("a"));
			});
			assert.match(bytes(SOURCE_ORGANIZATION_FILE)!, /pending/);
			assert.equal(events, 1);
			assert.deepEqual(ids(), ["a"]);
		});

		it("the event fires after the whole commit: a listener sees every ledger op, and a failed flush emits nothing", () => {
			let seen: string[] | null = null;
			const off = subscribe((e) => { if (e.type === "sources-changed") seen = ids(); });
			try {
				events = 0;
				graphStore.transact("t", () => {
					sourceOrganizationStore.write(org("first")); // the org write comes BEFORE the append
					graphStore.appendNode(node("late"));
				});
				assert.deepEqual(seen, ["late"], "listener at emit time reads the committed ledger");
				// a later op fails at flush: transact throws and no event was sent
				events = 0;
				fs.mkdirSync(SOURCES_FILE, { recursive: true }); // sources.json is now a directory: its flush op throws
				try {
					assert.throws(() => graphStore.transact("t", () => {
						sourceOrganizationStore.write(org("second"));
						graphStore.upsertSource(source("boom"));
					}));
				} finally { fs.rmSync(SOURCES_FILE, { recursive: true, force: true }); }
				assert.equal(events, 0);
			} finally { off(); }
		});

		it("a caller mutating the state after write cannot change what commits", () => {
			const state = org("snap");
			graphStore.transact("t", () => {
				sourceOrganizationStore.write(state);
				state.folders[0]!.name = "mutated";
				assert.equal(sourceOrganizationStore.read().folders[0]!.name, "snap");
			});
			assert.equal(sourceOrganizationStore.read().folders[0]!.name, "snap");
			assert.match(bytes(SOURCE_ORGANIZATION_FILE)!, /snap/);
		});

		it("a bare write still writes and emits immediately", () => {
			sourceOrganizationStore.write(org("bare"));
			assert.match(bytes(SOURCE_ORGANIZATION_FILE)!, /bare/);
			assert.equal(events, 1);
		});
	});
});
