/**
 * The two review-sync HOOKS that ride on routes (server/chats.ts delete, dismiss route), on BOTH graph backends:
 *   delete  — folds the chat's practice reviews into the ledger BEFORE the chat goes; a failed sync answers 503 and
 *             leaves the chat, its reviews and its traces untouched (the ledger outlives the chat: no silent loss).
 *   dismiss — writes exactly one `dismissed` line per dismissed problem, and a repeat adds none.
 * The routes run against the real composition root with its graph store swapped for the test's.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-hooks-"));
process.env.LH_DATA_DIR = TMP;

const { stores } = await import("../src/server/stores.ts");
const { createGraphStore } = await import("../src/store/graph.ts");
const { openNodeSqlite } = await import("../src/store/sql/drivers/node-sqlite.ts");
const { openGraphStore } = await import("../src/store/sql/graph-store.ts");
const { conclude, pose } = await import("./helpers/review-fixtures.ts");
const chatRoute = await import("../app/api/chats/[id]/route.ts");
const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");
import type { GraphStore } from "../src/core/ports.ts";

let dir: string;
let counter = 0;
before(() => { dir = fs.mkdtempSync(path.join(TMP, "g-")); });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

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

/** Run `fn` with the composition root's graph store swapped for `graph`. */
async function withGraph<T>(graph: GraphStore, fn: () => Promise<T>): Promise<T> {
	const slot = stores as { graphStore: GraphStore };
	const orig = slot.graphStore;
	slot.graphStore = graph;
	try { return await fn(); } finally { slot.graphStore = orig; }
}

const practiceChat = (messages: never[]) => {
	const chat = stores.chatStore.createChat("hooks", "practice");
	stores.chatStore.saveMessages(chat.id, messages);
	return chat.id;
};
const del = (id: string) => chatRoute.DELETE(new Request(`http://test/api/chats/${id}?mode=preserve-graph`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
const dismiss = (id: string, problemCallId: string) => dismissRoute.POST(
	new Request(`http://test/api/chats/${id}/dismiss`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: { type: "dismiss-problem", problemCallId } }) }),
	{ params: Promise.resolve({ id }) },
);

for (const backend of backends) {
	describe(`review hooks on the ${backend.name} backend`, () => {
		it("D1 a normal delete folds the concluded review into the ledger before the chat is gone", async () => {
			const { graph, close } = backend.make();
			const id = practiceChat([...pose("p1", ["n_a"]), ...conclude("c1", "solved", null, 2_000)] as never[]);
			assert.deepEqual(graph.readReviews(), [], "precondition: not yet logged");
			await withGraph(graph, async () => assert.equal((await del(id)).status, 200));
			assert.equal(stores.chatStore.getChat(id), null, "chat is gone");
			assert.deepEqual(graph.readReviews().map((r) => [r.id, r.outcome]), [[`${id}:p1`, "solved"]]);
			close();
		});

		it("D2 a failing review sync answers 503 and the chat, its reviews and its traces are untouched", async () => {
			const { graph, close } = backend.make();
			const id = practiceChat([...pose("p1", ["n_a"]), ...conclude("c1", "solved", null, 2_000)] as never[]);
			const touched: string[] = [];
			const failing = new Proxy(graph, {
				get(target, prop) {
					const value = Reflect.get(target, prop, target);
					if (typeof value !== "function") return value;
					return (...args: unknown[]) => {
						touched.push(String(prop));
						if (prop === "transact") throw new Error("ledger down");
						return value.apply(target, args);
					};
				},
			});
			await withGraph(failing, async () => {
				const res = await del(id);
				assert.equal(res.status, 503);
				assert.equal(((await res.json()) as { code: string }).code, "review_sync_failed");
			});
			assert.ok(stores.chatStore.getChat(id), "chat survives");
			assert.deepEqual(graph.readReviews(), [], "no partial review line");
			assert.deepEqual(touched.filter((m) => !["transact", "readReviews", "appendReview"].includes(m)), [], "no purge ran");
			// the ledger recovers: a retry deletes and keeps the review
			await withGraph(graph, async () => assert.equal((await del(id)).status, 200));
			assert.equal(stores.chatStore.getChat(id), null);
			assert.equal(graph.readReviews().length, 1);
			close();
		});

		it("X1 a dismiss writes exactly one dismissed line; a repeat dismiss adds no duplicate", async () => {
			const { graph, close } = backend.make();
			const id = practiceChat(pose("p1", ["n_a"]) as never[]);
			await withGraph(graph, async () => {
				assert.equal((await dismiss(id, "p1")).status, 200);
				assert.deepEqual(graph.readReviews().map((r) => [r.id, r.outcome]), [[`${id}:p1`, "dismissed"]]);
				await dismiss(id, "p1"); // 400 (nothing active) or 200: either way, no second line
				assert.equal(graph.readReviews().length, 1);
			});
			close();
		});
	});
}
