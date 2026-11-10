import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calibration } from "../../src/seed/cli";
import { clipSnippet, composeAllowEgress } from "../../src/seed/egress";
import { acceptProposal, dismissProposal, panelRows } from "../../src/seed/panel";
import type { Proposal } from "../../src/seed/proposals";
import { createSeedStore, type Decision } from "../../src/seed/store";
import type { HarvestItem } from "../../src/seed/types";
import { openNodeSqlite } from "../../src/store/sql/drivers/node-sqlite";
import { migrate } from "../../src/store/sql/migrate";
import { seedMigration } from "../../src/store/sql/migrations/seeds/index";

const T1 = "2026-11-01T00:00:00.000Z";
const T2 = "2026-11-02T00:00:00.000Z";
const allow = composeAllowEgress([]);

const item = (id: string, over: Partial<HarvestItem> = {}): HarvestItem => ({ id, source: "claude-history", project: "/work/app", sessionId: `s-${id}`, at: T1, signal: null, textRedacted: `question about ${id}`, ...over });
const prop = (id: string, over: Partial<Proposal> = {}): Proposal => ({
	id, title: `Topic ${id}`, why: "because", kind: "concept", prereqOf: null, firstSeen: T1, lastSeen: T1, nItems: 1, nProjects: 1, rankScore: 0.5, status: "proposed", mergedInto: null, evidenceIds: [`e-${id}`], ...over,
});

/** Each proposal gets its own evidence item `e-<id>` unless a test supplies items itself. */
function rig(proposals: Proposal[], decisions: Record<string, Decision> = {}, extraItems: HarvestItem[] = []) {
	const db = openNodeSqlite(":memory:");
	migrate(db, { ...seedMigration, lhVersion: "t" });
	const store = createSeedStore(db);
	store.upsertItems([...proposals.flatMap((p) => (p.evidenceIds.includes(`e-${p.id}`) ? [item(`e-${p.id}`)] : [])), ...extraItems]);
	store.saveProposals(proposals);
	for (const [id, d] of Object.entries(decisions)) store.saveRank(id, d, "{}", T1);
	return store;
}

describe("seed panel", () => {
	it("panelRows shows learn-labelled and propose/review, hides the rest", () => {
		const ids = ["learn-skip", "propose", "review", "skip", "none", "know", "skiplab", "accepted", "merged"];
		const store = rig(
			ids.map((id) => prop(id, id === "merged" ? { status: "merged" } : {})),
			{ "learn-skip": "skip", propose: "propose", review: "review", skip: "skip", none: "none", know: "propose", skiplab: "propose", accepted: "propose", merged: "propose" },
		);
		store.setLabel("learn-skip", "learn", T1);
		store.setLabel("know", "know", T1);
		store.setLabel("skiplab", "skip", T1);
		assert.equal(acceptProposal(store, allow, { proposalId: "accepted", chatId: "c", at: T2 }).kind, "accepted");
		assert.deepEqual(new Set(panelRows(store, allow).map((r) => r.id)), new Set(["learn-skip", "propose", "review"]));
	});

	it("panelRows orders by prerequisite edge, else by rankScore", () => {
		const withEdge = rig([prop("A", { prereqOf: "B", rankScore: 0.1 }), prop("B", { rankScore: 0.9 })], { A: "propose", B: "propose" });
		const rows = panelRows(withEdge, allow);
		assert.deepEqual(rows.map((r) => r.id), ["A", "B"]);
		assert.equal(rows[0]?.prerequisiteFor, "Topic B");
		assert.equal(rows[1]?.prerequisiteFor, null);
		const without = rig([prop("A", { rankScore: 0.1 }), prop("B", { rankScore: 0.9 })], { A: "propose", B: "propose" });
		assert.deepEqual(panelRows(without, allow).map((r) => r.id), ["B", "A"]);
	});

	it("panelRows row shape: evidence clipping, label, acceptable", () => {
		const long = `first   line\n\nwith   gaps ${"x".repeat(400)}`;
		const evItems = ["e1", "e2", "e3", "e4"].map((id) => item(id, { textRedacted: long }));
		const store = rig(
			[
				prop("P", { evidenceIds: ["e1", "e2", "e3", "e4"] }),
				prop("Q", { evidenceIds: ["s1"] }),
				prop("N", { evidenceIds: [] }),
			],
			{ P: "propose", Q: "propose", N: "propose" },
			[...evItems, item("s1", { project: "/work/secretco/app" })],
		);
		store.setLabel("P", "learn", T1);
		const rows = new Map(panelRows(store, composeAllowEgress(["secretco"])).map((r) => [r.id, r]));
		const p = rows.get("P")!;
		assert.equal(p.evidence.length, 3);
		for (const s of p.evidence) {
			assert.ok(s.length <= 120);
			assert.doesNotMatch(s, /\s{2}|\n/);
		}
		assert.equal(p.label, "learn");
		assert.equal(p.acceptable, true);
		assert.equal(rows.get("Q")!.label, null);
		assert.equal(rows.get("Q")!.acceptable, false);
		assert.equal(rows.get("N")!.acceptable, false);
		assert.equal(panelRows(store, allow).find((r) => r.id === "Q")!.acceptable, true);
	});

	it("acceptProposal writes the accept, a learn label and flips status", () => {
		const store = rig(
			[prop("P", { title: "Borrowing", evidenceIds: ["late", "early"] })],
			{ P: "propose" },
			[item("late", { at: T2, textRedacted: "late one" }), item("early", { at: T1, textRedacted: "early   one" })],
		);
		const res = acceptProposal(store, allow, { proposalId: "P", chatId: "chat-1", at: T2 });
		const expected = `I keep running into Borrowing (for example: ${clipSnippet("early   one")}). Teach me it from first principles, then check my understanding.`;
		assert.deepEqual(res, { kind: "accepted", firstMessage: expected });
		const acc = store.accepts();
		assert.equal(acc.length, 1);
		assert.equal(acc[0]?.chatId, "chat-1");
		assert.equal(acc[0]?.firstMessage, expected);
		assert.equal(store.labels().find((l) => l.proposalId === "P")?.verdict, "learn");
		assert.equal(store.loadProposals().find((x) => x.id === "P")?.status, "accepted");
	});

	it("accepted and dismissed labels feed calibration as the CLI report builds them", () => {
		const ps = [prop("P1", { rankScore: 0.9 }), prop("P2", { rankScore: 0.5 }), prop("P3", { rankScore: 0.2 })];
		const store = rig(ps, { P1: "propose", P2: "propose", P3: "propose" });
		assert.equal(acceptProposal(store, allow, { proposalId: "P1", chatId: "c", at: T2 }).kind, "accepted");
		assert.equal(dismissProposal(store, { proposalId: "P2", verdict: "know", at: T2 }).kind, "dismissed");
		assert.equal(dismissProposal(store, { proposalId: "P3", verdict: "skip", at: T2 }).kind, "dismissed");
		const proposals = new Map(store.loadProposals().map((p) => [p.id, p]));
		const rows = store.labels().map((l) => ({ id: l.proposalId, verdict: l.verdict, score: proposals.get(l.proposalId)?.rankScore ?? null }));
		assert.deepEqual(rows.map((r) => [r.id, r.verdict]), [["P1", "learn"], ["P2", "know"], ["P3", "skip"]]);
		const cal = calibration(rows);
		assert.equal(cal.steps.length, 11);
		assert.equal(cal.steps[0]?.recall, 1);
		assert.equal(cal.steps[0]?.precision, 0.5);
	});

	it("acceptProposal retry: same chat returns stored message, other chat is not-open", () => {
		const store = rig([prop("P")], { P: "propose" });
		const first = acceptProposal(store, allow, { proposalId: "P", chatId: "c1", at: T1 });
		assert.equal(first.kind, "accepted");
		assert.deepEqual(acceptProposal(store, allow, { proposalId: "P", chatId: "c1", at: T2 }), first);
		assert.equal(store.accepts().length, 1);
		assert.deepEqual(acceptProposal(store, allow, { proposalId: "P", chatId: "c2", at: T2 }), { kind: "not-open" });
		assert.equal(store.accepts().length, 1);
	});

	it("acceptProposal refusals", () => {
		const store = rig(
			[prop("S"), prop("O", { evidenceIds: ["o1"] }), prop("N", { evidenceIds: [] })],
			{ S: "propose", O: "propose", N: "propose" },
			[item("o1", { project: "/work/secretco/app" })],
		);
		store.setLabel("S", "skip", T1);
		const strict = composeAllowEgress(["secretco"]);
		assert.deepEqual(acceptProposal(store, allow, { proposalId: "nope", chatId: "c", at: T2 }), { kind: "not-found" });
		assert.deepEqual(acceptProposal(store, allow, { proposalId: "S", chatId: "c", at: T2 }), { kind: "not-open" });
		assert.deepEqual(acceptProposal(store, strict, { proposalId: "O", chatId: "c", at: T2 }), { kind: "opted-out" });
		assert.equal(store.labels().some((l) => l.proposalId === "O"), false);
		assert.equal(store.accepts().some((a) => a.proposalId === "O"), false);
		assert.deepEqual(acceptProposal(store, allow, { proposalId: "N", chatId: "c", at: T2 }), { kind: "no-evidence" });
		assert.equal(store.accepts().length, 0);
	});

	it("dismissProposal records the verdict, keeps status, and refuses closed or unknown", () => {
		const store = rig([prop("K"), prop("S"), prop("A")], { K: "propose", S: "propose", A: "propose" });
		assert.deepEqual(dismissProposal(store, { proposalId: "K", verdict: "know", at: T1 }), { kind: "dismissed" });
		assert.deepEqual(dismissProposal(store, { proposalId: "S", verdict: "skip", at: T1 }), { kind: "dismissed" });
		const labels = new Map(store.labels().map((l) => [l.proposalId, l.verdict]));
		assert.equal(labels.get("K"), "know");
		assert.equal(labels.get("S"), "skip");
		assert.ok(store.loadProposals().filter((p) => p.id !== "A").every((p) => p.status === "proposed"));
		assert.deepEqual(panelRows(store, allow).map((r) => r.id), ["A"]);
		acceptProposal(store, allow, { proposalId: "A", chatId: "c", at: T2 });
		assert.deepEqual(dismissProposal(store, { proposalId: "A", verdict: "know", at: T2 }), { kind: "not-open" });
		assert.deepEqual(dismissProposal(store, { proposalId: "zzz", verdict: "know", at: T2 }), { kind: "not-found" });
	});

	it("an existing learn label keeps its time through accept", () => {
		const store = rig([prop("P")], { P: "skip" });
		store.setLabel("P", "learn", T1);
		assert.equal(acceptProposal(store, allow, { proposalId: "P", chatId: "c", at: T2 }).kind, "accepted");
		const l = store.labels().find((x) => x.proposalId === "P");
		assert.deepEqual([l?.verdict, l?.at], ["learn", T1]);
	});
});
