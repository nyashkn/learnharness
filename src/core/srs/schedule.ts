/** The heatmap's data (Settings > Review): per-day activity behind today and FSRS due dates ahead. Pure fold
 *  over the same ledger + live graph as reviewQueue. Port of upstream PR #486's reviewSchedule. */

import { Rating, State } from "ts-fsrs";
import { gradeOf } from "./rating.ts";
import { historiesOf, introductionOrder, REVIEW_DAY_START_HOUR, reviewDayStart, reviewQueue, type ReviewQueueInput } from "./queue.ts";
import { replay, schedulerFor } from "./replay.ts";

/** The review-day key (YYYY-MM-DD, local) of the day containing `at`, with the 4 AM rollover. */
export function reviewDayKey(at: Date, dayStartHour = REVIEW_DAY_START_HOUR): string {
	const start = reviewDayStart(at, dayStartHour);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
}

/** One day behind (today included): what was studied, no per-problem detail. */
export interface ReviewPastDay {
	date: string;
	/** Review lines logged (one per concluded problem). */
	reviews: number;
	/** Distinct live propositions those reviews rated. */
	propositions: number;
	/** Per-proposition ratings that day (a multi-target review rates each target). */
	again: number;
	hard: number;
	good: number;
	/** Propositions whose FIRST review fell on that day. */
	introduced: number;
}

/** A practiced proposition's replayed FSRS card, as of `now`. */
export interface ReviewCardFacts {
	id: string;
	state: "learning" | "review" | "relearning";
	/** ISO: when it comes due. */
	due: string;
	/** ISO: its newest review. */
	lastReview: string;
	/** The interval FSRS last scheduled, in whole days (0 inside the steps). */
	intervalDays: number;
	stability: number;
	difficulty: number;
	/** Recall probability at `now` (0-1). */
	retrievability: number;
	reviews: number;
	lapses: number;
}

/** One day ahead (today included): what comes due. Today's day also holds everything overdue. */
export interface ReviewFutureDay {
	date: string;
	due: ReviewCardFacts[];
}

export interface ReviewSchedule {
	/** Today's review-day key. */
	today: string;
	/** The window's first and last day keys (inclusive). */
	start: string;
	end: string;
	/** Days with activity, oldest first. */
	past: ReviewPastDay[];
	/** Days with something due, soonest first; each day's cards soonest first. */
	future: ReviewFutureDay[];
	/** Never-practiced propositions today's allowance admits (reviewQueue's newAvailable). */
	newToday: string[];
	/** EVERY never-practiced live proposition, in introduction order. newToday is its prefix. */
	newBacklog: string[];
	/** Practiced propositions due after the window's end. */
	later: number;
}

const STATE_NAMES: Partial<Record<State, ReviewCardFacts["state"]>> = {
	[State.Learning]: "learning",
	[State.Review]: "review",
	[State.Relearning]: "relearning",
};

/** `pastDays` days back and `futureDays` ahead of today's review day. Past days count logged reviews (live
 *  targets only, reviewQueue's rule); future days place every practiced proposition on its replayed due day,
 *  overdue ones on today. New propositions never sit on a day: newToday is today's allowance, newBacklog all. */
export function reviewSchedule(input: ReviewQueueInput & { pastDays: number; futureDays: number }): ReviewSchedule {
	const dayStartHour = input.dayStartHour ?? REVIEW_DAY_START_HOUR;
	const scheduler = schedulerFor(input.scheduler);
	const live = new Set(input.nodes.map((n) => n.id));
	const history = historiesOf(input.reviews, live);
	const now = input.now.getTime();

	const todayStart = reviewDayStart(input.now, dayStartHour);
	const shifted = (days: number) =>
		new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + days, dayStartHour);
	const today = reviewDayKey(input.now, dayStartHour);
	const start = reviewDayKey(shifted(-input.pastDays), dayStartHour);
	const end = reviewDayKey(shifted(input.futureDays), dayStartHour);

	type PastAccumulator = ReviewPastDay & { ids: Set<string>; lines: Set<string> };
	const pastByDay = new Map<string, PastAccumulator>();
	const pastDay = (date: string): PastAccumulator => {
		let day = pastByDay.get(date);
		if (!day) {
			day = { date, reviews: 0, propositions: 0, again: 0, hard: 0, good: 0, introduced: 0, ids: new Set(), lines: new Set() };
			pastByDay.set(date, day);
		}
		return day;
	};
	const futureByDay = new Map<string, ReviewCardFacts[]>();
	let later = 0;

	for (const [id, events] of history) {
		events.forEach((event, i) => {
			const date = reviewDayKey(new Date(event.at), dayStartHour);
			if (date < start || date > today) return;
			const day = pastDay(date);
			day.lines.add(event.id);
			day.ids.add(id);
			const grade = gradeOf(event);
			if (grade === Rating.Again) day.again++;
			else if (grade === Rating.Hard) day.hard++;
			else day.good++;
			if (i === 0) day.introduced++;
		});

		const card = replay(events, input.scheduler)!;
		const date = card.due.getTime() <= now ? today : reviewDayKey(card.due, dayStartHour);
		if (date > end) {
			later++;
			continue;
		}
		const facts: ReviewCardFacts = {
			id,
			state: STATE_NAMES[card.state] ?? "learning",
			due: card.due.toISOString(),
			lastReview: new Date(events[events.length - 1]!.at).toISOString(),
			intervalDays: card.scheduled_days,
			stability: card.stability,
			difficulty: card.difficulty,
			retrievability: scheduler.retrievability(card, input.now),
			reviews: events.length,
			lapses: card.lapses,
		};
		const list = futureByDay.get(date) ?? [];
		list.push(facts);
		futureByDay.set(date, list);
	}

	const past = [...pastByDay.values()]
		.sort((a, b) => a.date.localeCompare(b.date))
		.map(({ ids, lines, ...day }) => ({ ...day, reviews: lines.size, propositions: ids.size }));
	const future = [...futureByDay.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, due]) => ({ date, due: due.sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id)) }));

	const fresh = input.nodes.filter((n) => !history.has(n.id));
	const newBacklog = introductionOrder(fresh, input.chains, Infinity);

	return { today, start, end, past, future, newToday: reviewQueue(input).newAvailable, newBacklog, later };
}
