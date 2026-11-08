import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { Rating } from "ts-fsrs";
import { gradeOf, ratingOf, replay, retrievabilityAt, type ReviewEvent, type ReviewOutcome, type ReviewRung } from "../src/core/srs/index.ts";

const outcomes: ReviewOutcome[] = ["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"];
const rungs: ReviewRung[] = [null, "R0", "R1", "R2", "R3", "R4", "R5"];
const T0 = Date.parse("2026-01-01T00:00:00Z");

const eventArb = fc
	.record({
		outcome: fc.constantFrom(...outcomes),
		rung: fc.constantFrom(...rungs),
		confidence: fc.option(fc.double({ min: -10, max: 110, noNaN: true }), { nil: undefined }),
		hours: fc.integer({ min: 0, max: 24 * 60 }),
	})
	.map(({ hours, ...rest }): ReviewEvent => ({ id: "e", at: new Date(T0 + hours * 3_600_000).toISOString(), ...rest }));
const historyArb = fc.array(eventArb, { minLength: 1, maxLength: 12 });

describe("srs rating", () => {
	it("pins the grading table by hand", () => {
		assert.equal(ratingOf("solved", "R0"), Rating.Good);
		assert.equal(ratingOf("solvedWithHints", null), Rating.Good);
		assert.equal(ratingOf("solved", "R1"), Rating.Good);
		assert.equal(ratingOf("solved", "R2"), Rating.Hard);
		assert.equal(ratingOf("solved", "R3"), Rating.Again);
		assert.equal(ratingOf("surrendered", "R0"), Rating.Again);
		assert.equal(ratingOf("movedOn", null), Rating.Again);
	});
	it("a right answer under confidence 50 is Hard; 50 itself is not shaky", () => {
		assert.equal(gradeOf({ outcome: "solved", rung: "R0", confidence: 49 }), Rating.Hard);
		assert.equal(gradeOf({ outcome: "solved", rung: "R0", confidence: 50 }), Rating.Good);
		assert.equal(gradeOf({ outcome: "solved", rung: "R0", confidence: Number.NaN }), Rating.Good);
	});
	it("property: never Easy, and confidence never raises a grade", () => {
		fc.assert(
			fc.property(eventArb, ({ outcome, rung, confidence }) => {
				const g = gradeOf({ outcome, rung, confidence });
				assert.ok(g >= Rating.Again && g <= Rating.Good);
				assert.ok(g <= ratingOf(outcome, rung));
				if (confidence === undefined) assert.equal(g, ratingOf(outcome, rung));
			}),
		);
	});
	it("property: a wrong answer is Again whatever the confidence", () => {
		fc.assert(
			fc.property(fc.constantFrom("movedOn", "surrendered", "dismissed") as fc.Arbitrary<ReviewOutcome>, fc.constantFrom(...rungs), fc.integer({ min: 0, max: 100 }), (outcome, rung, confidence) => {
				assert.equal(gradeOf({ outcome, rung, confidence }), Rating.Again);
			}),
		);
	});
});

describe("srs replay", () => {
	it("an empty history is never practiced", () => {
		assert.equal(replay([]), null);
		assert.equal(retrievabilityAt([], new Date(T0)), null);
	});
	it("rejects a bad timestamp instead of silently scheduling NaN", () => {
		assert.throws(() => replay([{ id: "x", at: "nope", outcome: "solved", rung: "R0" }]), RangeError);
	});
	it("regression: a ledger line stamped before its predecessor replays instead of throwing (shrunk seed 1826618808)", () => {
		const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();
		const ev = (id: string, at: string): ReviewEvent => ({ id, at, outcome: "solved", rung: null });
		assert.doesNotThrow(() => replay([ev("a", day(1)), ev("b", day(0))]));
		assert.deepEqual(replay([ev("a", day(1)), ev("b", day(0))]), replay([ev("a", day(1)), ev("b", day(1))]));
	});
	it("property: replay is deterministic", () => {
		fc.assert(fc.property(historyArb, (h) => assert.deepEqual(replay(h), replay(structuredClone(h)))));
	});
	it("property: replay is order-sensitive (a good-then-lapse differs from lapse-then-good)", () => {
		const good: ReviewEvent = { id: "g", at: new Date(T0).toISOString(), outcome: "solved", rung: "R0" };
		const again = (days: number): ReviewEvent => ({ id: "a", at: new Date(T0 + days * 86_400_000).toISOString(), outcome: "surrendered", rung: null });
		const goodLater = { ...good, at: new Date(T0 + 10 * 86_400_000).toISOString() };
		assert.notDeepEqual(replay([good, again(5), goodLater]), replay([again(5), good, goodLater]));
	});
	it("property: a lower grade at the end never schedules later than a higher one", () => {
		fc.assert(
			fc.property(historyArb, (h) => {
				const last = { ...h[h.length - 1]!, at: new Date(T0 + 90 * 86_400_000).toISOString() };
				const mk = (outcome: ReviewOutcome, rung: ReviewRung): ReviewEvent => ({ ...last, outcome, rung, confidence: undefined });
				const bad = replay([...h.slice(0, -1), mk("surrendered", null)])!;
				const good = replay([...h.slice(0, -1), mk("solved", "R0")])!;
				assert.ok(bad.due.getTime() <= good.due.getTime());
			}),
		);
	});
	it("property: retrievability is a probability and decays with time", () => {
		fc.assert(
			fc.property(historyArb, fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 400 }), (h, a, b) => {
				const base = replay(h)!.last_review!.getTime();
				const [early, late] = a <= b ? [a, b] : [b, a];
				const r1 = retrievabilityAt(h, new Date(base + early * 86_400_000))!;
				const r2 = retrievabilityAt(h, new Date(base + late * 86_400_000))!;
				assert.ok(r1 >= 0 && r1 <= 1 && r2 >= 0 && r2 <= 1);
				assert.ok(r2 <= r1 + 1e-12);
			}),
		);
	});
	it("derives state on read: replay never mutates its input", () => {
		fc.assert(fc.property(historyArb, (h) => { const before = structuredClone(h); replay(h); assert.deepEqual(h, before); }));
	});
});
