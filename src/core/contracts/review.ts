/**
 * Review-ledger contracts (R2): one line per concluded, targeted practice problem — the raw facts of how it
 * went, never a rating and never a memory state. FSRS state is derived by replaying these lines (core/srs).
 * Fields mirror upstream PR #486's ReviewEvent, plus the optional self-reported confidence.
 */

/** The conclude outcomes a review can carry ("dismissed" is the synthesized learner discard). */
export type ReviewOutcome = "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "dismissed";
/** The hint-ladder rung the problem needed; null = no hint given. */
export type ReviewRung = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | null;
/** The problem tool's demand mode. */
export type ReviewMode = "recall" | "discrimination" | "composition";
/** The conclude tool's miss classification; null = no miss. */
export type ReviewMissClass = "cue" | "discrimination" | "execution" | "careless" | "structural" | null;

/** One remap record (append-only): reviews of `from` now count for `to` (a merged node follows it to the current id).
 *  Stored apart from the review lines, which keep their original targets; readReviews resolves them. */
export interface ReviewRemap {
	from: string;
	to: string;
}

/** One review: one concluded practice problem. Every target shares the problem's outcome. */
export interface ReviewLine {
	/** chatId + ":" + problemCallId — the idempotency key of every sync. */
	id: string;
	chatId: string;
	problemCallId: string;
	/** ISO — when the problem concluded. */
	at: string;
	/** Graph proposition ids the problem exercised (never empty). */
	targets: string[];
	outcome: ReviewOutcome;
	rung: ReviewRung;
	mode?: ReviewMode;
	missClass?: ReviewMissClass;
	/** The problem's one-line situation class. */
	surface?: string;
	/** Self-reported 0-100; may only lower a grade, never raise one (core/srs/types.ts). */
	confidence?: number;
}
