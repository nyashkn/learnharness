/**
 * practiceReviewsOf (core/srs): one review line per concluded, targeted practice problem.
 * Expected values are hand-listed or come from the generator's spec, never from the fold.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { concludedByDismissalPair, newProblemDismissedMarker, PRACTICE_PROBLEM_TOOL, type LhMessage } from "../src/core/native-messages.ts";
import { practiceReviewsOf } from "../src/core/srs/index.ts";
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
			for (const l of lines) assert.equal("confidence" in l, false, "R1 demotion stays inert: no confidence is written");
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
});
