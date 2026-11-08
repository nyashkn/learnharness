import { Rating, type Grade } from "ts-fsrs";
import type { ReviewEvent, ReviewOutcome, ReviewRung } from "./types.ts";

/** A right answer given under this confidence is shaky: Hard (socrates retention.ts SHAKY_CONFIDENCE). */
export const SHAKY_CONFIDENCE = 50;

/** Outcome + hint rung -> rating. A solve rates by its rung alone: none/R0/R1 Good, R2 Hard,
 *  R3+ Again; anything unsolved (incl. dismissed, as in PR #486) is Again. Never Easy. */
export function ratingOf(outcome: ReviewOutcome, rung: ReviewRung): Grade {
	if (outcome !== "solved" && outcome !== "solvedWithHints") return Rating.Again;
	if (rung === "R3" || rung === "R4" || rung === "R5") return Rating.Again;
	if (rung === "R2") return Rating.Hard;
	return Rating.Good;
}

/** The grade of one event: ratingOf, then confidence may only demote a right answer to Hard. */
export function gradeOf(event: Pick<ReviewEvent, "outcome" | "rung" | "confidence">): Grade {
	const grade = ratingOf(event.outcome, event.rung);
	const c = event.confidence;
	const shaky = typeof c === "number" && Number.isFinite(c) && c < SHAKY_CONFIDENCE;
	return shaky ? (Math.min(grade, Rating.Hard) as Grade) : grade;
}
