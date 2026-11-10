/** reviewQueue (core/srs): due ordering, the newPerDay cap, deleted propositions, the 4 AM day. Expectations are hand-listed or modelled independently. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import type { ReviewLine, ReviewOutcome, ReviewRung } from "../src/core/contracts/review.ts";
import { reviewDayStart, reviewQueue } from "../src/core/srs/index.ts";

const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const node = (id: string, createdDay = 1) => ({ id, createdAt: local(createdDay, 12).toISOString() });
let seq = 0;
const review = (targets: string[], at: Date, outcome: ReviewOutcome = "solved", rung: ReviewRung = null): ReviewLine => {
	seq++;
	return { id: `chat:p${seq}`, chatId: "chat", problemCallId: `p${seq}`, at: at.toISOString(), targets, outcome, rung };
};
const ids = (n: number) => Array.from({ length: n }, (_, i) => `n_${String(i).padStart(3, "0")}`);

describe("reviewQueue", () => {
	it("Q1 newPerDay caps new introductions: min(cap, fresh) are admitted, none when cap is 0 (property)", () => {
		fc.assert(fc.property(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 20 }), (n, cap) => {
			const q = reviewQueue({ reviews: [], nodes: ids(n).map((i) => node(i)), chains: [], now: local(10, 12), newPerDay: cap });
			assert.equal(q.newAvailable.length, Math.min(cap, n));
		}));
	});

	it("Q2 the allowance counts propositions first reviewed since today's 4 AM", () => {
		const nodes = ["n_1", "n_2", "n_3", "n_4"].map((i) => node(i));
		const reviews = [review(["n_1"], local(2, 5))];
		assert.deepEqual(reviewQueue({ reviews, nodes, chains: [], newPerDay: 2, now: local(3, 3) }).newAvailable, ["n_2"]);
		assert.deepEqual(reviewQueue({ reviews, nodes, chains: [], newPerDay: 2, now: local(3, 5) }).newAvailable, ["n_2", "n_3"]);
	});

	it("Q3 reviews of deleted propositions are skipped: never due, spend no allowance (property)", () => {
		fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 6 }), (goneIdx) => {
			const gone = goneIdx.map((i) => `n_gone${i}`);
			const q = reviewQueue({ reviews: gone.map((g) => review([g], local(3, 10))), nodes: [node("n_live")], chains: [], newPerDay: 1, now: local(3, 12) });
			assert.deepEqual(q.due, []);
			assert.deepEqual(q.newAvailable, ["n_live"]);
		}));
	});

	it("Q4 due ordering: equal grades come due in review-time order, most overdue first (property)", () => {
		fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 8 }), (days) => {
			const nodes = days.map((d) => node(`n_d${String(d).padStart(2, "0")}`));
			const reviews = days.map((d) => review([`n_d${String(d).padStart(2, "0")}`], local(d, 12)));
			const q = reviewQueue({ reviews, nodes, chains: [], now: local(28, 12) });
			const expected = [...days].sort((a, b) => a - b).map((d) => `n_d${String(d).padStart(2, "0")}`);
			assert.deepEqual(q.due, expected);
		}));
	});

	it("Q5 a fresh success is not due; an old one and a recent miss are", () => {
		const q = reviewQueue({
			nodes: [node("n_fresh"), node("n_old"), node("n_miss")], chains: [], newPerDay: 10, now: local(20, 12),
			reviews: [review(["n_fresh"], local(20, 11, 59)), review(["n_old"], local(1, 12)), review(["n_miss"], local(20, 10), "surrendered", "R5")],
		});
		assert.deepEqual(new Set(q.due), new Set(["n_old", "n_miss"]));
		assert.ok(!q.newAvailable.includes("n_fresh"));
	});

	it("Q6 a multi-target review schedules every target", () => {
		const q = reviewQueue({ nodes: [node("n_a"), node("n_b")], chains: [], reviews: [review(["n_a", "n_b"], local(1, 12))], now: local(25, 12) });
		assert.deepEqual(new Set(q.due), new Set(["n_a", "n_b"]));
	});

	it("Q7 new propositions: premises before conclusions, then oldest first; a cycle releases its oldest", () => {
		const q = reviewQueue({ reviews: [], nodes: [node("n_old", 1), node("n_new", 3), node("n_mid", 2)], chains: [{ premises: ["n_new"], conclusion: "n_old" }], now: local(10, 12) });
		assert.deepEqual(q.newAvailable, ["n_mid", "n_new", "n_old"]);
		const cyc = reviewQueue({ reviews: [], nodes: [node("n_a", 1), node("n_b", 2)], chains: [{ premises: ["n_a"], conclusion: "n_b" }, { premises: ["n_b"], conclusion: "n_a" }], now: local(10, 12) });
		assert.deepEqual(cyc.newAvailable, ["n_a", "n_b"]);
	});

	it("Q8 picks: due first, then new, capped at the session size (8)", () => {
		const nodes = ids(12).map((i) => node(i));
		const q = reviewQueue({ nodes, chains: [], reviews: nodes.slice(0, 5).map((n) => review([n.id], local(1, 12))), now: local(25, 12) });
		assert.equal(q.picks.length, 8);
		assert.deepEqual(q.picks.slice(0, 5), q.due);
		assert.deepEqual(q.picks.slice(5), q.newAvailable.slice(0, 3));
	});

	it("Q9 ledger order, not clock order, defines the history: a backwards-stamped line still replays", () => {
		const q = reviewQueue({ nodes: [node("n_a")], chains: [], reviews: [review(["n_a"], local(5, 12)), review(["n_a"], local(4, 12))], now: local(25, 12) });
		assert.deepEqual(q.due, ["n_a"]);
	});

	it("Q10 an unparseable timestamp is skipped, not fatal", () => {
		const bad = { ...review(["n_a"], local(1, 12)), at: "not-a-date" };
		const q = reviewQueue({ nodes: [node("n_a")], chains: [], reviews: [bad], now: local(25, 12) });
		assert.deepEqual(q.newAvailable, ["n_a"]);
	});

	it("Q11 the 4 AM rollover", () => {
		assert.equal(reviewDayStart(local(2, 3)).getTime(), local(1, 4).getTime());
		assert.equal(reviewDayStart(local(2, 4)).getTime(), local(2, 4).getTime());
	});
});
