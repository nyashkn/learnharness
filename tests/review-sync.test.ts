/**
 * Review sync (server/review.ts) on BOTH graph backends (file, sqlite), plus GET /api/review:
 *   exactly one line per concluded practice problem, idempotent re-sync, ONE transact per sync (a throw leaves
 *   nothing), untagged problems, teach chats, deleted propositions, remapped targets, the summary shape.
 * Expected values are listed by hand or come from the generator's spec, never from the code under test.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import fc from "fast-check";
import { GET } from "../app/api/review/route.ts";
import type { GraphNode } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { backfillReviews, reviewSummary, syncChatReviews } from "../src/server/review.ts";
import { createGraphStore } from "../src/store/graph.ts";
import { openNodeSqlite } from "../src/store/sql/drivers/node-sqlite.ts";
import { openGraphStore } from "../src/store/sql/graph-store.ts";
import { conclude, OUTCOMES, pose, recordOf, type ProblemSpec } from "./helpers/review-fixtures.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

let dir: string;
let counter = 0;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-sync-")); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const backends: { name: string; make: () => { graph: GraphStore; close: () => void } }[] = [
	{ name: "file", make: () => { const d = path.join(dir, `f${counter++}`); fs.mkdirSync(d, { recursive: true }); return { graph: createGraphStore(d), close: () => {} }; } },
	{
		name: "sqlite",
		make: () => {
			const raw = openNodeSqlite(path.join(dir, `g${counter++}.sqlite`));
			let p = {};
			const opened = openGraphStore({ db: raw, file: "graph.sqlite", lhVersion: "test", positions: { read: () => p, write: (n) => { p = n; } }, log: () => {} });
			return { graph: opened.store, close: () => raw.close() };
		},
	},
];

const node = (id: string): GraphNode => ({ id, name: `name ${id}`, statement: `statement ${id}`, aliases: [], createdAt: "2026-01-01T00:00:00.000Z", provenance: [] });
const chats = (records: Record<string, { kind: "practice" | "teach"; messages: LhMessage[] }>): Pick<ChatStore, "getChat" | "listChats"> => ({
	getChat: (id) => (records[id] ? ({ id, ...records[id] } as never) : null),
	listChats: () => Object.entries(records).map(([id, r]) => ({ id, kind: r.kind }) as never),
});
const specArb = fc.array(
	fc.record({ tagged: fc.boolean(), concluded: fc.boolean(), outcome: fc.constantFrom(...OUTCOMES) }),
	{ maxLength: 8 },
).map((xs): ProblemSpec[] => xs.map((x, i) => ({ ...x, id: String(i) })));

for (const backend of backends) {
	describe(`review sync on the ${backend.name} backend`, () => {
		it("S1 one line per concluded tagged problem, and a re-sync is idempotent (property)", () => {
			const { graph, close } = backend.make();
			let run = 0;
			fc.assert(fc.property(specArb, (specs) => {
				const chatId = `chat${run++}`;
				const store = chats({ [chatId]: { kind: "practice", messages: recordOf(specs) } });
				const expected = specs.filter((s) => s.tagged && s.concluded).map((s) => `${chatId}:p_${s.id}`);
				assert.equal(syncChatReviews(chatId, { chatStore: store, graphStore: graph }), expected.length);
				assert.equal(syncChatReviews(chatId, { chatStore: store, graphStore: graph }), 0, "second sync appends nothing");
				assert.deepEqual(graph.readReviews().filter((r) => r.chatId === chatId).map((r) => r.id), expected);
			}), { numRuns: 25 });
			close();
		});

		it("S2 the sync is ONE transact: a throw on the second append leaves no line", () => {
			const { graph, close } = backend.make();
			const messages = [...pose("p1", ["n_a"]), ...conclude("c1", "solved", null, 2_000), ...pose("p2", ["n_b"], 3_000), ...conclude("c2", "movedOn", null, 4_000)];
			let appends = 0;
			const flaky = {
				transact: graph.transact.bind(graph),
				readReviews: graph.readReviews.bind(graph),
				appendReview: (l: Parameters<GraphStore["appendReview"]>[0]) => { if (++appends === 2) throw new Error("boom"); graph.appendReview(l); },
			};
			assert.throws(() => syncChatReviews("c", { chatStore: chats({ c: { kind: "practice", messages } }), graphStore: flaky }), /boom/);
			assert.deepEqual(graph.readReviews(), [], "rolled back: the first append left no trace");
			assert.equal(syncChatReviews("c", { chatStore: chats({ c: { kind: "practice", messages } }), graphStore: graph }), 2, "a later sync completes");
			close();
		});

		it("S3 dedupe reads the ledger INSIDE the transact: a line another writer appended in between is not duplicated", () => {
			const { graph, close } = backend.make();
			const messages = [...pose("p1", ["n_a"]), ...conclude("c1", "solved", null)];
			const store = chats({ c: { kind: "practice", messages } });
			const racing = {
				...graph, // spread loses prototype methods on class stores; bind explicitly
				transact: <T,>(label: string, fn: () => T): T => graph.transact(label, () => {
					graph.appendReview({ id: "c:p1", chatId: "c", problemCallId: "p1", at: new Date(0).toISOString(), targets: ["n_a"], outcome: "solved", rung: null });
					return fn();
				}),
				readReviews: graph.readReviews.bind(graph),
				appendReview: graph.appendReview.bind(graph),
			};
			assert.equal(syncChatReviews("c", { chatStore: store, graphStore: racing }), 0);
			assert.equal(graph.readReviews().length, 1);
			close();
		});

		it("S4 teach chats and unknown ids are no-ops", () => {
			const { graph, close } = backend.make();
			const store = chats({ t: { kind: "teach", messages: [...pose("p1", ["n_a"]), ...conclude("c1", "solved", null)] } });
			assert.equal(syncChatReviews("t", { chatStore: store, graphStore: graph }), 0);
			assert.equal(syncChatReviews("nope", { chatStore: store, graphStore: graph }), 0);
			assert.deepEqual(graph.readReviews(), []);
			close();
		});

		it("S5 backfill folds every practice chat once, idempotently", () => {
			const { graph, close } = backend.make();
			const rec = (t: string) => ({ kind: "practice" as const, messages: [...pose("p1", [t]), ...conclude("c1", "solved", null)] });
			const store = chats({ a: rec("n_a"), b: rec("n_b"), t: { kind: "teach", messages: rec("n_c").messages } });
			assert.equal(backfillReviews({ chatStore: store, graphStore: graph }), 2);
			assert.equal(backfillReviews({ chatStore: store, graphStore: graph }), 0);
			assert.deepEqual(graph.readReviews().map((r) => r.id).sort(), ["a:p1", "b:p1"]);
			close();
		});

		it("S6 summary: deleted propositions are skipped, a practiced one is due, a remapped target is scheduled under its CURRENT id", () => {
			const { graph, close } = backend.make();
			for (const id of ["n_new", "n_other"]) graph.appendNode(node(id));
			const old = (id: string, target: string) => ({ id, chatId: "c", problemCallId: id, at: "2026-01-02T12:00:00.000Z", targets: [target], outcome: "solved" as const, rung: null });
			graph.appendReview(old("c:p1", "n_old")); // n_old merged into n_new
			graph.appendReview(old("c:p2", "n_deleted")); // no such node
			graph.remapReviewTargets("n_old", "n_new");
			const s = reviewSummary(new Date("2026-06-01T12:00:00.000Z"), graph);
			assert.deepEqual(s.picks.map((p) => p.id), ["n_new", "n_other"], "n_new due (remapped), n_other new, deleted skipped");
			assert.equal(s.dueCount, 1);
			assert.equal(s.newCount, 1);
			assert.deepEqual(s.picks[0], { id: "n_new", name: "name n_new", statement: "statement n_new" });
			close();
		});
	});
}

describe("GET /api/review", () => {
	it("R1 returns the summary shape", async () => {
		const res = await GET();
		assert.equal(res.status, 200);
		const body = (await res.json()) as Record<string, unknown>;
		assert.deepEqual(Object.keys(body).sort(), ["dueCount", "newCount", "picks"]);
		assert.equal(typeof body.dueCount, "number");
		assert.equal(typeof body.newCount, "number");
		assert.ok(Array.isArray(body.picks));
	});
});
