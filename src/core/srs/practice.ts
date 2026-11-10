/** A practice record -> its review lines: one per concluded, targeted problem, in record order.
 *  Pure fold over the SAVED record (the sync seam reads saved records only, so the ledger never holds a
 *  conclude the transcript lost). Calls count only through clean results; a conclude attaches to the
 *  newest cleanly-posed problem before it; a dismissal marker concludes its problem as "dismissed" and the
 *  synthesized conclude that follows is the same problem (identity dedupes it). Untagged problems are no review.
 *  Lines carry no `confidence` (R1's demotion stays inert) and no `surface` (doctrine, bead R3b). */

import type { ReviewLine, ReviewMissClass, ReviewMode, ReviewOutcome, ReviewRung } from "../contracts/review.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMarkerMessage, type LhMessage } from "../native-messages.ts";

const OUTCOMES: readonly ReviewOutcome[] = ["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"];
const RUNGS: readonly Exclude<ReviewRung, null>[] = ["R0", "R1", "R2", "R3", "R4", "R5"];
const MODES: readonly ReviewMode[] = ["recall", "discrimination", "composition"];
const MISS_CLASSES: readonly Exclude<ReviewMissClass, null>[] = ["cue", "discrimination", "execution", "careless", "structural"];

function targetsOf(args: unknown): string[] {
	const target = (args as { target?: unknown } | undefined)?.target;
	if (!Array.isArray(target)) return [];
	return [...new Set(target.filter((t): t is string => typeof t === "string" && t.length > 0))];
}

const rungOf = (raw: unknown): ReviewRung => (RUNGS.includes(raw as Exclude<ReviewRung, null>) ? (raw as ReviewRung) : null);

function missClassOf(raw: unknown): Pick<ReviewLine, "missClass"> {
	if (raw === null) return { missClass: null };
	return MISS_CLASSES.includes(raw as Exclude<ReviewMissClass, null>) ? { missClass: raw as ReviewMissClass } : {};
}

export function practiceReviewsOf(chatId: string, messages: readonly LhMessage[]): ReviewLine[] {
	const resultAt = new Map<string, number>();
	for (const m of messages) {
		if (m.role === "toolResult" && !m.isError) resultAt.set(m.toolCallId, m.timestamp);
	}
	const posed = new Map<string, unknown>(); // clean problem call id -> its arguments
	const reviews: ReviewLine[] = [];
	const seen = new Set<string>();
	const emit = (problemCallId: string, at: number, outcome: unknown, rung: unknown, missClass?: unknown) => {
		if (seen.has(problemCallId) || !posed.has(problemCallId)) return;
		if (!OUTCOMES.includes(outcome as ReviewOutcome)) return;
		const args = posed.get(problemCallId);
		const targets = targetsOf(args);
		if (targets.length === 0) return;
		seen.add(problemCallId);
		const mode = (args as { mode?: unknown } | undefined)?.mode;
		reviews.push({
			id: `${chatId}:${problemCallId}`,
			chatId,
			problemCallId,
			at: new Date(at).toISOString(),
			targets,
			outcome: outcome as ReviewOutcome,
			rung: outcome === "dismissed" ? null : rungOf(rung),
			...(MODES.includes(mode as ReviewMode) ? { mode: mode as ReviewMode } : {}),
			...(outcome === "dismissed" ? {} : missClassOf(missClass)),
		});
	};

	let active: string | null = null;
	for (const m of messages) {
		if (m.role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType !== "problem-dismissed") continue;
			const problemCallId = (marker.details as { problemCallId?: unknown } | undefined)?.problemCallId;
			if (typeof problemCallId === "string") emit(problemCallId, marker.timestamp, "dismissed", null);
			if (problemCallId === active) active = null;
			continue;
		}
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall") continue;
			const at = resultAt.get(block.id);
			if (at === undefined) continue; // errored or dangling: it never happened
			if (block.name === PRACTICE_PROBLEM_TOOL) {
				posed.set(block.id, block.arguments);
				active = block.id;
			} else if (block.name === PRACTICE_CONCLUDE_TOOL && active !== null) {
				const args = (block.arguments ?? {}) as { outcome?: unknown; rung?: unknown; missClass?: unknown };
				emit(active, at, args.outcome, args.rung, args.missClass);
				active = null;
			}
		}
	}
	return reviews;
}
