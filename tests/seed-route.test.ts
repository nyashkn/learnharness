/**
 * /api/seed (the home "Proposed sessions" panel): GET lists, POST accepts or dismisses. Drives the real route
 * handlers over a seeds.sqlite built here. LH_DATA_DIR comes from the tests/isolate-data-dir.ts preload.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { PATHS } from "../config.ts";
import { createSeedStore } from "../src/seed/store.ts";
import type { Proposal } from "../src/seed/proposals.ts";
import type { HarvestItem } from "../src/seed/types.ts";
import { migrate } from "../src/store/sql/migrate.ts";
import { seedMigration } from "../src/store/sql/migrations/seeds/index.ts";
import { openNodeSqlite } from "../src/store/sql/drivers/node-sqlite.ts";

const { GET, POST } = await import("../app/api/seed/route.ts");
const chats = await import("../app/api/chats/route.ts");
const graph = await import("../app/api/graph/route.ts");

const FILE = path.join(PATHS.data, "seeds.sqlite");
const OPTOUT = path.join(PATHS.data, "seed-optout.txt");
const AT = "2026-01-01T00:00:00.000Z";

const item = (id: string, project: string, text: string): HarvestItem => ({ id, source: "claude-history", project, sessionId: null, at: AT, signal: null, textRedacted: text });
const proposal = (id: string, title: string, evidenceIds: string[]): Proposal => ({
	id, title, why: `why ${id}`, kind: "concept", prereqOf: null, firstSeen: AT, lastSeen: AT,
	nItems: evidenceIds.length, nProjects: 1, rankScore: 1, status: "proposed", mergedInto: null, evidenceIds,
});

function withDb<T>(fn: (store: ReturnType<typeof createSeedStore>) => T): T {
	const db = openNodeSqlite(FILE);
	try {
		return fn(createSeedStore(db));
	} finally {
		db.close();
	}
}

/** Fresh seeds.sqlite: p1/p2/p3 on alpha-notes evidence, p4 on beta-notes evidence. All ranked "propose". */
function fixture() {
	clean();
	const db = openNodeSqlite(FILE);
	try {
		migrate(db, { ...seedMigration, lhVersion: "t" });
		const s = createSeedStore(db);
		s.upsertItems([item("i1", "alpha-notes", "the borrow checker keeps rejecting my loop"), item("i2", "beta-notes", "my flux capacitor derivation is stuck")]);
		s.saveProposals([proposal("p1", "ownership rules", ["i1"]), proposal("p2", "lifetimes", ["i1"]), proposal("p3", "traits", ["i1"]), proposal("p4", "capacitors", ["i2"])]);
		for (const id of ["p1", "p2", "p3", "p4"]) s.saveRank(id, "propose", "{}", AT);
	} finally {
		db.close();
	}
}

function clean() {
	for (const f of ["", "-wal", "-shm"]) fs.rmSync(FILE + f, { force: true });
	fs.rmSync(OPTOUT, { force: true });
}

const get = () => GET();
const post = (body: unknown, raw = false) =>
	POST(new Request("http://test/api/seed", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) }));
async function newChat(): Promise<string> {
	const res = await chats.POST(new Request("http://test/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "seeded" }) }));
	return ((await res.json()) as { id: string }).id;
}
const ids = async () => ((await (await get()).json()) as { proposals: { id: string }[] }).proposals.map((p) => p.id);

beforeEach(fixture);

describe("/api/seed", () => {
	it("GET with no seeds.sqlite returns an empty list and does not create the file", async () => {
		clean();
		const res = await get();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { proposals: [] });
		assert.equal(fs.existsSync(FILE), false);
	});

	it("GET lists open proposals with the panel fields", async () => {
		const res = await get();
		assert.equal(res.status, 200);
		const { proposals } = (await res.json()) as { proposals: Record<string, unknown>[] };
		assert.equal(proposals.length, 4);
		const p1 = proposals.find((p) => p.id === "p1")!;
		assert.deepEqual(Object.keys(p1).sort(), ["acceptable", "evidence", "id", "kind", "label", "prerequisiteFor", "title", "why"]);
		assert.equal(p1.title, "ownership rules");
		assert.equal(p1.why, "why p1");
		assert.equal(p1.prerequisiteFor, null);
		assert.equal(p1.label, null);
		assert.equal(p1.acceptable, true);
		assert.deepEqual(p1.evidence, ["the borrow checker keeps rejecting my loop"]);
	});

	it("accept returns the stored opening, records label + chat, and closes the proposal", async () => {
		const chatId = await newChat();
		const res = await post({ action: "accept", id: "p1", chatId });
		assert.equal(res.status, 200);
		const { firstMessage } = (await res.json()) as { firstMessage: string };
		assert.ok(firstMessage.length > 0);
		assert.ok(firstMessage.startsWith("I keep running into"));
		withDb((s) => {
			assert.equal(s.labels().find((l) => l.proposalId === "p1")?.verdict, "learn");
			assert.equal(s.accepts().find((a) => a.proposalId === "p1")?.chatId, chatId);
		});
		assert.ok(!(await ids()).includes("p1"));
	});

	it("dismiss know and skip store the label and close the proposals", async () => {
		for (const [id, verdict] of [["p1", "know"], ["p2", "skip"]] as const) {
			const res = await post({ action: "dismiss", id, verdict });
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { ok: true });
		}
		withDb((s) => {
			assert.equal(s.labels().find((l) => l.proposalId === "p1")?.verdict, "know");
			assert.equal(s.labels().find((l) => l.proposalId === "p2")?.verdict, "skip");
		});
		const open = await ids();
		assert.ok(!open.includes("p1") && !open.includes("p2"));
		assert.ok(open.includes("p3"));
	});

	it("refuses: unknown chat 404, unknown proposal 404, dismissed proposal 409", async () => {
		assert.equal((await post({ action: "accept", id: "p1", chatId: "no-such-chat" })).status, 404);
		const chatId = await newChat();
		assert.equal((await post({ action: "accept", id: "nope", chatId })).status, 404);
		assert.equal((await post({ action: "dismiss", id: "nope", verdict: "know" })).status, 404);
		assert.equal((await post({ action: "dismiss", id: "p3", verdict: "skip" })).status, 200);
		assert.equal((await post({ action: "accept", id: "p3", chatId })).status, 409);
		assert.equal((await post({ action: "dismiss", id: "p3", verdict: "know" })).status, 409);
	});

	it("rejects invalid bodies with 400", async () => {
		const bad: unknown[] = [
			{ id: "p1" },
			{ action: "dismiss", id: "p1", verdict: "learn" },
			{ action: "accept", id: "p1", chatId: "a/b" },
			{ action: "accept", id: "p1", chatId: "abc", extra: 1 },
			{ action: "dismiss", id: "p1", verdict: "know", extra: 1 },
		];
		for (const b of bad) assert.equal((await post(b)).status, 400, JSON.stringify(b));
		assert.equal((await post("not json {", true)).status, 400);
	});

	it("an opted-out project makes its proposal unacceptable and accept refuses without writing a label", async () => {
		fs.writeFileSync(OPTOUT, "# private\nbeta-notes\n");
		const { proposals } = (await (await get()).json()) as { proposals: { id: string; acceptable: boolean }[] };
		assert.equal(proposals.find((p) => p.id === "p4")?.acceptable, false);
		assert.equal(proposals.find((p) => p.id === "p1")?.acceptable, true);
		const chatId = await newChat();
		assert.equal((await post({ action: "accept", id: "p4", chatId })).status, 409);
		withDb((s) => {
			assert.equal(s.labels().some((l) => l.proposalId === "p4"), false);
			assert.equal(s.accepts().length, 0);
		});
	});

	// Cases 7 and 8 together. The graph check: GET /api/graph (the graph store's whole view) is identical before and after,
	// so no source or node was imported. Chats live in a separate store and do not appear in the graph view.
	it("makes no provider call and imports nothing into the graph", async () => {
		const chatId = await newChat();
		const graphBefore = JSON.stringify(await (await graph.GET()).json());
		const realFetch = globalThis.fetch;
		const calls: unknown[] = [];
		globalThis.fetch = (async (...args: unknown[]) => {
			calls.push(args);
			throw new Error("network is off in this test");
		}) as typeof fetch;
		try {
			assert.equal((await get()).status, 200);
			assert.equal((await post({ action: "accept", id: "p1", chatId })).status, 200);
			assert.equal((await post({ action: "dismiss", id: "p2", verdict: "know" })).status, 200);
			assert.equal((await post({ action: "dismiss", id: "p3", verdict: "skip" })).status, 200);
		} finally {
			globalThis.fetch = realFetch;
		}
		assert.equal(calls.length, 0);
		assert.equal(JSON.stringify(await (await graph.GET()).json()), graphBefore);
	});
});
