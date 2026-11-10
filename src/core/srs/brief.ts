/** The history brief (2026-11-02): each pick's earlier practice, for the practice agent's session context. Pure.
 *  Same replay and grading as the queue, so "overdue" here is exactly "due" there. Facts older lines never
 *  recorded (mode, surface, missClass) stay unknown. */

import { Rating } from "ts-fsrs";
import type { ReviewLine, ReviewMode } from "../contracts/review.ts";
import { gradeOf } from "./rating.ts";
import { replay } from "./replay.ts";
import type { SchedulerSettings } from "./types.ts";

/** How many recent surfaces the brief lists per pick. */
export const REVIEW_BRIEF_SURFACES = 3;
const DAY_MS = 86_400_000;
const MODES: readonly ReviewMode[] = ["recall", "discrimination", "composition"];

export type ReviewBriefStatus = { kind: "new" } | { kind: "overdue"; days: number } | { kind: "scheduled"; days: number };

export interface ReviewBriefEntry {
	id: string;
	status: ReviewBriefStatus;
	reviews: number;
	/** Reviews graded Again. */
	misses: number;
	/** The deepest mode solved cleanly (graded Good); null when none, or no review recorded a mode. */
	highestCleanMode: ReviewMode | null;
	last: (Pick<ReviewLine, "outcome" | "rung" | "mode" | "missClass"> & { daysAgo: number }) | null;
	/** The newest recorded surfaces, newest first, at most REVIEW_BRIEF_SURFACES. */
	recentSurfaces: string[];
}

export function reviewBriefOf(input: {
	reviews: readonly ReviewLine[];
	pickIds: readonly string[];
	now: Date;
	scheduler?: SchedulerSettings;
}): ReviewBriefEntry[] {
	// Each pick's lines in LEDGER order (as the queue folds them); an unparseable time is skipped.
	const picks = new Set(input.pickIds);
	const history = new Map<string, ReviewLine[]>();
	for (const line of input.reviews) {
		if (Number.isNaN(new Date(line.at).getTime())) continue;
		for (const target of new Set(line.targets)) {
			if (!picks.has(target)) continue;
			const list = history.get(target);
			if (list) list.push(line);
			else history.set(target, [line]);
		}
	}
	const now = input.now.getTime();
	return input.pickIds.map((id): ReviewBriefEntry => {
		const events = history.get(id);
		if (!events) return { id, status: { kind: "new" }, reviews: 0, misses: 0, highestCleanMode: null, last: null, recentSurfaces: [] };
		const due = replay(events, input.scheduler)!.due.getTime();
		let highest = -1;
		for (const e of events) if (e.mode && gradeOf(e) === Rating.Good) highest = Math.max(highest, MODES.indexOf(e.mode));
		const last = events[events.length - 1]!;
		return {
			id,
			status: due <= now ? { kind: "overdue", days: Math.floor((now - due) / DAY_MS) } : { kind: "scheduled", days: Math.floor((due - now) / DAY_MS) },
			reviews: events.length,
			misses: events.filter((e) => gradeOf(e) === Rating.Again).length,
			highestCleanMode: highest < 0 ? null : MODES[highest]!,
			last: {
				outcome: last.outcome,
				rung: last.rung,
				...(last.mode ? { mode: last.mode } : {}),
				...(last.missClass !== undefined ? { missClass: last.missClass } : {}),
				daysAgo: Math.floor((now - new Date(last.at).getTime()) / DAY_MS),
			},
			recentSurfaces: events
				.map((e) => e.surface)
				.filter((s): s is string => s !== undefined)
				.slice(-REVIEW_BRIEF_SURFACES)
				.reverse(),
		};
	});
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const daysText = (days: number) => plural(days, "day", "days");

/** The brief as session-context lines (one per pick, ids first — the graph-context marker's id convention). */
export function formatReviewBrief(entries: readonly ReviewBriefEntry[]): string[] {
	return entries.map((entry) => {
		if (entry.status.kind === "new") return `- [${entry.id}] new — never practiced`;
		const parts = [
			entry.status.kind === "overdue"
				? entry.status.days === 0
					? "due now"
					: `overdue ${daysText(entry.status.days)}`
				: entry.status.days === 0
					? "due within a day"
					: `due in ${daysText(entry.status.days)}`,
			`${plural(entry.reviews, "review", "reviews")}, ${plural(entry.misses, "miss", "misses")}`,
			`highest clean mode: ${entry.highestCleanMode ?? "none"}`,
		];
		const last = entry.last!;
		const when = last.daysAgo === 0 ? "today" : `${daysText(last.daysAgo)} ago`;
		const facts = [
			last.outcome,
			`rung ${last.rung ?? "none"}`,
			...(last.mode ? [`mode ${last.mode}`] : []),
			...(last.missClass !== undefined ? [`miss ${last.missClass ?? "none"}`] : []),
		];
		parts.push(`last (${when}): ${facts.join(", ")}`);
		if (entry.recentSurfaces.length > 0) {
			parts.push(`recent surfaces: ${entry.recentSurfaces.map((s) => JSON.stringify(s)).join("; ")}`);
		}
		return `- [${entry.id}] ${parts.join(" · ")}`;
	});
}
