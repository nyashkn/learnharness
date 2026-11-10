/**
 * practiceReviewsOf (core/srs): one review line per concluded, targeted practice problem.
 * Expected values are hand-listed or come from the generator's spec, never from the fold.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { concludedByDismissalPair, newProblemDismissedMarker, PRACTICE_PROBLEM_TOOL, type LhMessage } from "../src/core/native-messages.ts";
import { CONFIDENCE_STOPS } from "../src/core/question-core.ts";
import { gradeOf, practiceReviewsOf } from "../src/core/srs/index.ts";
import { call, conclude, OUTCOMES, pose, recordOf, type ProblemSpec } from "./helpers/review-fixtures.ts";

const specArb = fc.array(
	fc.record({ tagged: fc.boolean(), concluded: fc.boolean(), outcome: fc.constantFrom(...OUTCOMES) }),
	{ maxLength: 12 },
).map((xs): ProblemSpec[] => xs.map((x, i) => ({ ...x, id: String(i) })));

describe("practiceReviewsOf", () => {
	it("P1 exactly one line per concluded, tagged problem, in record order (property)", () => {
		fc.assert(fc.property(specArb, (specs) => {
			const lines = practiceReviewsOf("chat", recordOf(specs));
			const expected = specs.filter((s) => s.tagged && s.concluded);
			assert.deepEqual(lines.map((l) => l.id), expected.map((s) => `chat:p_${s.id}`));
			assert.deepEqual(lines.map((l) => l.outcome), expected.map((s) => s.outcome));
			assert.deepEqual(lines.map((l) => l.targets), expected.map((s) => [`n_${s.id}`]));
			for (const l of lines) assert.equal("confidence" in l, false, "no confidence was concluded, so none is written");
		}));
	});

	it("P2 a clean conclude reviews at the conclude result's time", () => {
		const [l] = practiceReviewsOf("chat1", [...pose("p1", ["n_a"]), ...conclude("c1", "solvedWithHints", "R1")]);
		assert.deepEqual(l, { id: "chat1:p1", chatId: "chat1", problemCallId: "p1", at: new Date(5_001).toISOString(), targets: ["n_a"], outcome: "solvedWithHints", rung: "R1", mode: "recall", missClass: null });
	});

	it("P3 multi-target problems carry every target once", () => {
		const [l] = practiceReviewsOf("c", [...pose("p1", ["n_a", "n_b", "n_a"]), ...conclude("c1", "solved", null)]);
		assert.deepEqual(l!.targets, ["n_a", "n_b"]);
	});

	it("P4 untagged problems are not reviews", () => {
		assert.deepEqual(practiceReviewsOf("c", [...pose("p1", undefined), ...conclude("c1", "solved", null)]), []);
		assert.deepEqual(practiceReviewsOf("c", [...pose("p1", []), ...conclude("c1", "solved", null)]), []);
	});

	it("P5 an errored or dangling conclude never happened; a still-active problem is no review", () => {
		assert.deepEqual(practiceReviewsOf("c", [...pose("p1", ["n_a"]), ...conclude("c1", "solved", null, 5_000, true)]), []);
		assert.deepEqual(practiceReviewsOf("c", [...pose("p1", ["n_a"]), ...conclude("c1", "solved", null).slice(0, 1)]), []);
		assert.deepEqual(practiceReviewsOf("c", pose("p1", ["n_a"])), []);
	});

	it("P6 an errored pose never activates: the conclude attaches to the clean one", () => {
		const messages = [
			...pose("p1", ["n_a"]),
			...call("p_bad", PRACTICE_PROBLEM_TOOL, { statement: "x", mode: "recall", modelSolution: "x", target: ["n_b"] }, 2_000, true),
			...conclude("c1", "solved", null),
		];
		assert.deepEqual(practiceReviewsOf("c", messages).map((r) => r.targets), [["n_a"]]);
	});

	it("P7 a dismissal marker is a 'dismissed' line (rung null); the synthesized conclude is the same line", () => {
		const marker = { ...newProblemDismissedMarker("p1"), timestamp: 3_000 };
		const alone = practiceReviewsOf("c", [...pose("p1", ["n_a"]), marker]);
		assert.equal(alone.length, 1);
		assert.equal(alone[0]!.outcome, "dismissed");
		assert.equal(alone[0]!.rung, null);
		assert.equal(alone[0]!.at, new Date(3_000).toISOString());
		const withPair = practiceReviewsOf("c", [...pose("p1", ["n_a"]), marker, ...(concludedByDismissalPair("p1") as LhMessage[])]);
		assert.deepEqual(withPair, alone);
	});

	it("P8 unknown outcome word is no review; unknown rung reads null; unknown mode/missClass stay absent", () => {
		assert.deepEqual(practiceReviewsOf("c", [...pose("p1", ["n_a"]), ...conclude("c1", "aced", null)]), []);
		const [l] = practiceReviewsOf("c", [...pose("p1", ["n_a"], 1_000, { mode: "drill" }), ...conclude("c1", "solved", "R9", 5_000, false, "weird")]);
		assert.equal(l!.rung, null);
		assert.equal("mode" in l!, false);
		assert.equal("missClass" in l!, false);
	});

	it("P9 records the brief's facts: mode and trimmed surface from the pose, miss class from the conclude", () => {
		const [l] = practiceReviewsOf("c", [
			...pose("p1", ["n_a"], 1_000, { mode: "composition", surface: "  ladder against a wall, find the angle  " }),
			...conclude("c1", "surrendered", "R4", 5_000, false, "discrimination"),
		]);
		assert.equal(l!.mode, "composition");
		assert.equal(l!.surface, "ladder against a wall, find the angle");
		assert.equal(l!.missClass, "discrimination");
	});

	it("P10 a blank or non-string surface stays absent — never guessed", () => {
		for (const surface of ["   ", 7, null]) {
			const [l] = practiceReviewsOf("c", [...pose("p1", ["n_a"], 1_000, { surface: surface as never }), ...conclude("c1", "solved", null)]);
			assert.equal("surface" in l!, false);
		}
	});

	it("P10b an over-long surface (older lines predate the schema cap) is cut to its first 200 chars after trimming", () => {
		const long = "a".repeat(150) + "b".repeat(150);
		const [l] = practiceReviewsOf("c", [...pose("p1", ["n_a"], 1_000, { surface: `  ${long}  ` }), ...conclude("c1", "solved", null)]);
		assert.equal(l!.surface, "a".repeat(150) + "b".repeat(50));
	});

	it("P11 the conclude's confidence rides the line; absent stays absent; a dismissal never carries it; non-stops drop", () => {
		const one = (confidence?: unknown) => practiceReviewsOf("c", [...pose("p1", ["n_a"]), ...conclude("c1", "solved", null, 5_000, false, null, confidence)])[0]!;
		for (const stop of CONFIDENCE_STOPS) assert.equal(one(stop).confidence, stop);
		assert.equal("confidence" in one(), false);
		for (const bad of [65, 101, -1, "50", null, Number.NaN]) assert.equal("confidence" in one(bad), false, String(bad));
		const dismissed = practiceReviewsOf("c", [...pose("p1", ["n_a"]), { ...newProblemDismissedMarker("p1"), timestamp: 3_000 }])[0]!;
		assert.equal("confidence" in dismissed, false);
		const dismissedConclude = practiceReviewsOf("c", [...pose("p1", ["n_a"]), ...conclude("c1", "dismissed", null, 5_000, false, null, 30)])[0]!;
		assert.equal(dismissedConclude.outcome, "dismissed");
		assert.equal("confidence" in dismissedConclude, false);
	});

	it("P12 ACCEPTANCE: a right answer concluded with confidence under 50 grades Hard; without it (or at 50+) Good — oracle table, property over stops x outcome x rung", () => {
		// Independent oracle (ts-fsrs Rating: Again 1, Hard 2, Good 3), not gradeOf's own tables.
		const base = (outcome: string, rung: string | null) =>
			outcome !== "solved" && outcome !== "solvedWithHints" ? 1 : ["R3", "R4", "R5"].includes(rung ?? "") ? 1 : rung === "R2" ? 2 : 3;
		const gradeOfRecord = (outcome: string, rung: string | null, confidence?: number) => {
			const [line] = practiceReviewsOf("c", [...pose("p1", ["n_a"]), ...conclude("c1", outcome, rung, 5_000, false, null, confidence)]);
			return gradeOf(line!);
		};
		assert.equal(gradeOfRecord("solved", null, 30), 2);
		assert.equal(gradeOfRecord("solved", null), 3);
		assert.equal(gradeOfRecord("solved", null, 50), 3);
		fc.assert(fc.property(
			fc.constantFrom(...OUTCOMES), fc.constantFrom<string | null>(null, "R0", "R1", "R2", "R3", "R4", "R5"), fc.option(fc.constantFrom(...CONFIDENCE_STOPS), { nil: undefined }),
			(outcome, rung, confidence) => {
				const expected = confidence !== undefined && confidence < 50 ? Math.min(base(outcome, rung), 2) : base(outcome, rung);
				assert.equal(gradeOfRecord(outcome, rung, confidence), expected);
			},
		));
	});
});
