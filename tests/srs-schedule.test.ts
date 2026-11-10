/**
 * reviewSchedule (core/srs) + reviewScheduleView/groupNewBacklog (server): day keys with the 4 AM rollover, past-day
 * tallies, overdue cards on today, the window's `later` overflow, the new backlog. Expectations are hand-listed or come
 * from independent models (calendar arithmetic, set algebra over the generated reviews), never from the code under test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import type { ReviewLine, ReviewOutcome, ReviewRung } from "../src/core/contracts/review.ts";
import { FACTORY_SCHEDULER, reviewDayKey, reviewSchedule } from "../src/core/srs/index.ts";
import { groupNewBacklog, reviewScheduleView } from "../src/server/review.ts";
import { FACTORY_SETTINGS } from "../src/core/settings.ts";
import { createGraphStore } from "../src/store/graph.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const node = (id: string, createdDay = 1) => ({ id, createdAt: local(createdDay, 12).toISOString() });
let seq = 0;
const review = (targets: string[], at: Date, outcome: ReviewOutcome = "solved", rung: ReviewRung = null): ReviewLine => {
	seq++;
	return { id: `chat:p${seq}`, chatId: "chat", problemCallId: `p${seq}`, at: at.toISOString(), targets, outcome, rung };
};
const run = (extra: Partial<Parameters<typeof reviewSchedule>[0]> & { now: Date }) =>
	reviewSchedule({ reviews: [], nodes: [], chains: [], pastDays: 30, futureDays: 30, ...extra });
const key = (y: number, mo: number, d: number) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("reviewDayKey", () => {
	it("D1 the 4 AM rollover, hand-listed", () => {
		assert.equal(reviewDayKey(local(10, 3, 59)), "2026-11-09");
		assert.equal(reviewDayKey(local(10, 4, 0)), "2026-11-10");
		assert.equal(reviewDayKey(new Date(2026, 0, 1, 2)), "2025-12-31", "across a year boundary");
		assert.equal(reviewDayKey(local(10, 1), 0), "2026-11-10", "a custom rollover hour");
	});

	it("D2 every local time keys to its calendar date minus one before 4 AM (property, calendar-arithmetic oracle)", () => {
		fc.assert(fc.property(fc.integer({ min: 0, max: 700 }), fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), (offset, h, m) => {
			const at = new Date(2025, 0, 1 + offset, h, m);
			const cal = new Date(Date.UTC(2025, 0, 1 + offset - (h < 4 ? 1 : 0)));
			assert.equal(reviewDayKey(at), key(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate()));
		}));
	});
});

describe("reviewSchedule", () => {
	it("SC1 the window keys: today, start and end are the review days pastDays back and futureDays ahead", () => {
		const s = run({ now: local(10, 12), pastDays: 5, futureDays: 20 });
		assert.deepEqual([s.start, s.today, s.end], ["2026-11-05", "2026-11-10", "2026-11-30"]);
		assert.equal(run({ now: local(10, 2), pastDays: 0, futureDays: 0 }).today, "2026-11-09", "before 4 AM is still yesterday");
	});

	it("SC2 past days tally grades per target; a multi-target review is one line, many propositions", () => {
		const s = run({
			now: local(10, 12),
			nodes: [node("n_a"), node("n_b"), node("n_c")],
			reviews: [
				review(["n_a", "n_b"], local(8, 10), "solved", "R0"), // good x2
				review(["n_c"], local(8, 11), "solvedWithHints", "R2"), // hard
				review(["n_a"], local(8, 12), "surrendered", "R5"), // again
			],
		});
		assert.deepEqual(s.past, [{ date: "2026-11-08", reviews: 3, propositions: 3, again: 1, hard: 1, good: 2, introduced: 3 }]);
	});

	it("SC3 introduced counts a proposition on its FIRST review's day only; days outside the window and deleted propositions drop", () => {
		const s = run({
			now: local(10, 12), pastDays: 3,
			nodes: [node("n_a")],
			reviews: [review(["n_a"], local(1, 10)), review(["n_a"], local(8, 10)), review(["n_gone"], local(8, 10))],
		});
		assert.deepEqual(s.past.map((d) => [d.date, d.reviews, d.introduced]), [["2026-11-08", 1, 0]], "day 1 is outside the window; n_gone is not live");
	});

	it("SC4 an overdue card sits on TODAY, never on a past day (the bucketing guard)", () => {
		const s = run({ now: local(20, 12), nodes: [node("n_old")], reviews: [review(["n_old"], local(1, 12))] });
		assert.deepEqual(s.future.map((d) => [d.date, d.due.map((c) => c.id)]), [["2026-11-20", ["n_old"]]]);
		assert.equal(s.later, 0);
	});

	it("SC5 a card due beyond the window counts in `later`, inside it lands on its due day", () => {
		// Without learning steps a first Good schedules a multi-day interval.
		const scheduler = { ...FACTORY_SCHEDULER, shortTerm: false };
		const input = { now: local(10, 12), nodes: [node("n_a")], reviews: [review(["n_a"], local(10, 11))], scheduler };
		const tight = run({ ...input, futureDays: 0 });
		assert.deepEqual([tight.future.length, tight.later], [0, 1]);
		const wide = run({ ...input, futureDays: 365 });
		assert.equal(wide.later, 0);
		assert.equal(wide.future.length, 1);
		assert.ok(wide.future[0]!.date > wide.today, "scheduled ahead, not overdue");
		assert.equal(reviewDayKey(new Date(wide.future[0]!.due[0]!.due)), wide.future[0]!.date, "the day key is the due card's own day");
		assert.ok(wide.future[0]!.due[0]!.intervalDays >= 1);
	});

	it("SC6 card facts: state, review count, lapses, retrievability in (0, 1], lastReview is the newest line", () => {
		const s = run({
			now: local(10, 12), nodes: [node("n_a")],
			reviews: [review(["n_a"], local(5, 10)), review(["n_a"], local(9, 10), "surrendered", "R5")],
		});
		const card = s.future[0]!.due[0]!;
		assert.equal(card.reviews, 2);
		assert.equal(card.lastReview, local(9, 10).toISOString());
		assert.ok(card.retrievability > 0 && card.retrievability <= 1);
		assert.ok(["learning", "review", "relearning"].includes(card.state));
	});

	it("SC7 conservation: every live practiced id is on exactly one future day or in `later`; new ones are the rest (property)", () => {
		const ids = ["n_0", "n_1", "n_2", "n_3", "n_4", "n_5"];
		const lineArb = fc.record({ targets: fc.uniqueArray(fc.constantFrom(...ids, "n_gone"), { minLength: 1, maxLength: 3 }), day: fc.integer({ min: 1, max: 9 }), hour: fc.integer({ min: 5, max: 20 }) });
		fc.assert(fc.property(fc.array(lineArb, { maxLength: 10 }), fc.integer({ min: 0, max: 12 }), fc.integer({ min: 0, max: 30 }), (lines, cap, futureDays) => {
			const reviews = lines.map((l) => review(l.targets, local(l.day, l.hour)));
			const s = run({ now: local(10, 12), nodes: ids.map((i) => node(i)), reviews, newPerDay: cap, futureDays });
			const practiced = new Set(lines.flatMap((l) => l.targets).filter((t) => ids.includes(t)));
			const placed = s.future.flatMap((d) => d.due.map((c) => c.id));
			assert.equal(new Set(placed).size, placed.length, "no card twice");
			assert.equal(placed.length + s.later, practiced.size);
			assert.ok(placed.every((p) => practiced.has(p)));
			assert.deepEqual([...s.newBacklog].sort(), ids.filter((i) => !practiced.has(i)).sort(), "the backlog is exactly the never-practiced live set");
			assert.deepEqual(s.newToday, s.newBacklog.slice(0, s.newToday.length), "today's allowance is a prefix of the backlog");
			assert.ok(s.newToday.length <= cap);
			assert.equal(s.past.reduce((n, d) => n + d.reviews, 0), lines.filter((l) => l.targets.some((t) => ids.includes(t))).length);
		}));
	});
});

describe("groupNewBacklog", () => {
	const pick = (id: string) => ({ id, name: `name ${id}`, statement: `s ${id}` });
	it("G1 topics are labeled regions sorted by size then label; unlabeled and unmatched go to Other, last", () => {
		const topics = groupNewBacklog(
			["a", "b", "c", "d", "e", "f"].map(pick),
			["a", "e"],
			[
				{ id: "r1", label: "Zeta", members: ["a"] },
				{ id: "r2", label: "Alpha", members: ["b", "c"] },
				{ id: "r3", label: null, members: ["d"] },
				{ id: "r4", label: "Beta", members: ["e"] },
			],
		);
		assert.deepEqual(topics.map((t) => [t.label, t.problems.map((p) => p.id)]), [["Alpha", ["b", "c"]], ["Beta", ["e"]], ["Zeta", ["a"]], [null, ["d", "f"]]]);
		assert.deepEqual(topics.flatMap((t) => t.problems.filter((p) => p.today).map((p) => p.id)).sort(), ["a", "e"]);
	});

	it("G2 a partition: every backlog problem appears exactly once, in introduction order within its topic (property)", () => {
		const ids = Array.from({ length: 12 }, (_, i) => `n_${i}`);
		fc.assert(fc.property(fc.uniqueArray(fc.constantFrom(...ids), { maxLength: 12 }), fc.array(fc.record({ label: fc.option(fc.constantFrom("A", "B", "C"), { nil: null }), members: fc.uniqueArray(fc.constantFrom(...ids), { maxLength: 5 }) }), { maxLength: 4 }), (backlog, regs) => {
			const topics = groupNewBacklog(backlog.map(pick), [], regs.map((r, i) => ({ id: `r${i}`, ...r })));
			assert.deepEqual(topics.flatMap((t) => t.problems.map((p) => p.id)).sort(), [...backlog].sort());
			for (const t of topics) {
				const positions = t.problems.map((p) => backlog.indexOf(p.id));
				assert.deepEqual(positions, [...positions].sort((x, y) => x - y));
			}
			assert.ok(topics.slice(0, -1).every((t) => t.id !== null), "Other is never before a named topic");
		}));
	});
});

describe("reviewScheduleView", () => {
	it("V1 names the cards and backlog from the live graph and groups with the injected regions", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-schedule-view-"));
		try {
			const graph = createGraphStore(dir);
			for (const id of ["n_a", "n_b"]) graph.appendNode({ id, name: `name ${id}`, statement: `statement ${id}`, aliases: [], createdAt: "2026-01-01T00:00:00.000Z", provenance: [] });
			graph.appendReview({ id: "c:p1", chatId: "c", problemCallId: "p1", at: "2026-01-02T12:00:00.000Z", targets: ["n_a"], outcome: "solved", rung: null });
			const now = new Date("2026-06-01T12:00:00.000Z");
			const view = reviewScheduleView(now, graph, { ...FACTORY_SETTINGS.review, newPerDay: 0 }, () => [{ id: "r1", label: "Topic", members: ["n_b"] }]);
			assert.equal(view.future[0]!.due[0]!.name, "name n_a");
			assert.deepEqual(view.newToday, [], "newPerDay 0 admits none today");
			assert.deepEqual(view.newBacklog, [{ id: "r1", label: "Topic", problems: [{ id: "n_b", name: "name n_b", statement: "statement n_b", today: false }] }]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
