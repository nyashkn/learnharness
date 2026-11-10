/** The history brief: core/srs/brief.ts (pure) and server reviewBriefLines (never fails the chat creation it rides on).
 *  Expectations are hand-listed or modelled independently of the code under test. */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import fc from "fast-check";
import type { ReviewLine, ReviewOutcome, ReviewRung } from "../src/core/contracts/review.ts";
import { formatReviewBrief, reviewBriefOf } from "../src/core/srs/index.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-brief-"));
process.env.LH_DATA_DIR = TMP_DATA;
const { reviewBriefLines } = await import("../src/server/review.ts");
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
let seq = 0;
const review = (targets: string[], at: Date, outcome: ReviewOutcome = "solved", rung: ReviewRung = null, extra: Partial<ReviewLine> = {}): ReviewLine => {
	seq++;
	return { id: `chat:p${seq}`, chatId: "chat", problemCallId: `p${seq}`, at: at.toISOString(), targets, outcome, rung, ...extra };
};

describe("reviewBriefOf — the history brief", () => {
	it("a never-practiced pick is new", () => {
		const [entry] = reviewBriefOf({ reviews: [], pickIds: ["n_a"], now: local(9, 12) });
		assert.deepEqual(entry, { id: "n_a", status: { kind: "new" }, reviews: 0, misses: 0, highestCleanMode: null, last: null, recentSurfaces: [] });
		assert.deepEqual(formatReviewBrief([entry!]), ["- [n_a] new — never practiced"]);
	});

	it("counts reviews and misses, keeps pick order, and ignores other targets", () => {
		const reviews = [review(["n_a"], local(1, 12)), review(["n_a", "n_z"], local(2, 12), "surrendered", "R5"), review(["n_b"], local(3, 12))];
		const entries = reviewBriefOf({ reviews, pickIds: ["n_b", "n_a"], now: local(4, 12) });
		assert.deepEqual(entries.map((e) => [e.id, e.reviews, e.misses]), [["n_b", 1, 0], ["n_a", 2, 1]]);
	});

	it("the highest clean mode needs a solve at R1 or below", () => {
		const reviews = [
			review(["n_a"], local(1, 12), "solved", "R0", { mode: "recall" }),
			review(["n_a"], local(2, 12), "solvedWithHints", "R1", { mode: "discrimination" }),
			review(["n_a"], local(3, 12), "solved", "R2", { mode: "composition" }),
			review(["n_a"], local(4, 12), "surrendered", null, { mode: "composition" }),
		];
		assert.equal(reviewBriefOf({ reviews, pickIds: ["n_a"], now: local(5, 12) })[0]!.highestCleanMode, "discrimination");
	});

	it("a shaky solve (confidence under 50) is not clean, as in replay", () => {
		const reviews = [review(["n_a"], local(1, 12), "solved", "R0", { mode: "composition", confidence: 10 })];
		assert.equal(reviewBriefOf({ reviews, pickIds: ["n_a"], now: local(5, 12) })[0]!.highestCleanMode, null);
	});

	it("overdue vs scheduled follows the FSRS replay; days are whole", () => {
		const reviews = [review(["n_a"], local(1, 12))];
		const [soon] = reviewBriefOf({ reviews, pickIds: ["n_a"], now: local(1, 12, 1) }); // short-term step: minutes, not days
		assert.deepEqual(soon!.status, { kind: "scheduled", days: 0 });
		assert.match(formatReviewBrief([soon!])[0]!, / due within a day · /);
		const [late] = reviewBriefOf({ reviews, pickIds: ["n_a"], now: new Date(2026, 11, 30, 12) });
		assert.ok(late!.status.kind === "overdue" && late!.status.days > 0);
	});

	it("lists the newest surfaces first, at most three; old lines without one are skipped", () => {
		const reviews = ["s1", "s2", "s3", "s4"].map((surface, i) => review(["n_a"], local(1 + i, 12), "solved", null, { surface }));
		reviews.push(review(["n_a"], local(6, 12)));
		assert.deepEqual(reviewBriefOf({ reviews, pickIds: ["n_a"], now: local(7, 12) })[0]!.recentSurfaces, ["s4", "s3", "s2"]);
	});

	it("the last review carries only the facts it recorded", () => {
		const [entry] = reviewBriefOf({ reviews: [review(["n_a"], local(1, 12), "movedOn", "R3")], pickIds: ["n_a"], now: local(3, 13) });
		assert.deepEqual(entry!.last, { outcome: "movedOn", rung: "R3", daysAgo: 2 });
	});

	it("formats one line per pick, ids first", () => {
		const reviews = [
			review(["n_a"], local(1, 12), "solved", null, { mode: "recall", missClass: null, surface: "a ladder" }),
			review(["n_a"], local(2, 12), "surrendered", "R4", { mode: "discrimination", missClass: "discrimination", surface: "a ramp" }),
		];
		const [line] = formatReviewBrief(reviewBriefOf({ reviews, pickIds: ["n_a"], now: local(2, 12) }));
		assert.match(line!, /^- \[n_a\] (due now|overdue \d+ days?|due within a day|due in \d+ days?) · 2 reviews, 1 miss · highest clean mode: recall · /);
		assert.ok(line!.includes("last (today): surrendered, rung R4, mode discrimination, miss discrimination"));
		assert.ok(line!.endsWith('recent surfaces: "a ramp"; "a ladder"'));
	});

	it("P1 one entry and one line per pick in pick order; reviews and misses match an independent count (property)", () => {
		const lineArb = fc.record({
			targets: fc.uniqueArray(fc.constantFrom<string>("n_a", "n_b", "n_c", "n_d"), { minLength: 1, maxLength: 3 }),
			outcome: fc.constantFrom<ReviewOutcome>("solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"),
			rung: fc.constantFrom<ReviewRung>(null, "R0", "R1", "R2", "R3", "R5"),
		});
		fc.assert(fc.property(
			fc.array(lineArb, { maxLength: 10 }),
			fc.uniqueArray(fc.constantFrom("n_a", "n_b", "n_c", "n_d", "n_e"), { maxLength: 5 }),
			(specs, picks) => {
				const reviews = specs.map((s, i) => review(s.targets, local(1 + i, 12), s.outcome, s.rung));
				const entries = reviewBriefOf({ reviews, pickIds: picks, now: local(20, 12) });
				assert.deepEqual(entries.map((e) => e.id), picks);
				assert.equal(formatReviewBrief(entries).length, picks.length);
				entries.forEach((e, i) => {
					const mine = specs.filter((s) => s.targets.includes(picks[i]!));
					assert.equal(e.reviews, mine.length);
					// Again = anything unsolved, or a solve that needed hint rung R3+ (independent of ratingOf).
					assert.equal(e.misses, mine.filter((s) => (s.outcome !== "solved" && s.outcome !== "solvedWithHints") || s.rung === "R3" || s.rung === "R5").length);
					assert.equal(e.status.kind === "new", mine.length === 0);
				});
			},
		));
	});
});

describe("reviewBriefLines (server)", () => {
	it("formats the ledger's history for the picks", () => {
		const reviews = [review(["n_a"], local(1, 12), "solved", null, { mode: "recall", surface: "a ladder" })];
		const lines = reviewBriefLines(["n_a", "n_new"], local(2, 12), { readReviews: () => reviews });
		assert.equal(lines.length, 2);
		assert.ok(lines[0]!.startsWith("- [n_a] "));
		assert.ok(lines[0]!.includes('recent surfaces: "a ladder"'));
		assert.equal(lines[1], "- [n_new] new — never practiced");
	});

	it("a failing read never throws: the session starts without a brief", () => {
		const orig = console.error;
		console.error = () => {};
		try {
			assert.deepEqual(reviewBriefLines(["n_a"], local(2, 12), { readReviews: () => { throw new Error("disk gone"); } }), []);
		} finally {
			console.error = orig;
		}
	});
});
