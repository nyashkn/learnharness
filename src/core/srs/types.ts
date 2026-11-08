/** SRS core types: what the review ledger (R2) hands this pure core. */

export type ReviewOutcome = "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "dismissed";
/** Hint rung: R0 none .. R5 full reveal. `null` = no hint recorded. */
export type ReviewRung = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | null;

/** One ledger line. Ledger order is semantic: replay folds events in the order given. */
export interface ReviewEvent {
	id: string;
	/** ISO timestamp. */
	at: string;
	outcome: ReviewOutcome;
	rung: ReviewRung;
	/** Self-reported 0-100; may only lower a grade, never raise one. */
	confidence?: number;
}

/** FSRS knobs; defaults mirror upstream PR #486's factory review settings. */
export interface SchedulerSettings {
	desiredRetention: number;
	maximumIntervalDays: number;
	fuzz: boolean;
	shortTerm: boolean;
	learningSteps: readonly string[];
	relearningSteps: readonly string[];
}

export const FACTORY_SCHEDULER: SchedulerSettings = {
	desiredRetention: 0.9,
	maximumIntervalDays: 36500,
	fuzz: false,
	shortTerm: true,
	learningSteps: ["1m", "10m"],
	relearningSteps: ["10m"],
};
