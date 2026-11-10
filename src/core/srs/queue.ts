/** The due queue: what to practice now. Pure fold over the review ledger (in ledger order, as readReviews
 *  gives it, targets already remap-resolved) and the live graph. Every live proposition is enrolled:
 *  practiced ones are scheduled by their FSRS replay; never-practiced ones enter at `newPerDay` a day (a
 *  proposition spends its slot on its FIRST logged review, so an abandoned pick is offered again).
 *  Reviews naming deleted propositions are skipped; a multi-target review rates every target. */

import type { GraphChain, GraphNode } from "../contracts/graph.ts";
import type { ReviewLine } from "../contracts/review.ts";
import { replay } from "./replay.ts";
import type { SchedulerSettings } from "./types.ts";

/** Anki's rollover: study before 4 AM counts toward the previous day. */
export const REVIEW_DAY_START_HOUR = 4;
/** How many propositions one review session picks. */
export const REVIEW_SESSION_SIZE = 8;
/** Never-practiced propositions admitted per day, factory value. */
export const FACTORY_NEW_PER_DAY = 10;

export interface ReviewQueueInput {
	reviews: readonly ReviewLine[];
	/** The LIVE propositions (core/graph.ts getGraph, merged by id). */
	nodes: readonly Pick<GraphNode, "id" | "createdAt">[];
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[];
	now: Date;
	newPerDay?: number;
	dayStartHour?: number;
	sessionSize?: number;
	scheduler?: SchedulerSettings;
}

export interface ReviewQueue {
	/** Practiced propositions whose FSRS due date has passed, most overdue first. */
	due: string[];
	/** Never-practiced propositions today's allowance still admits, in introduction order. */
	newAvailable: string[];
	/** The next session's propositions: due first, then new, capped at the session size. */
	picks: string[];
}

/** The start of the review day containing `now` (local time). */
export function reviewDayStart(now: Date, dayStartHour = REVIEW_DAY_START_HOUR): Date {
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), dayStartHour);
	if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 1);
	return start;
}

/** The first `limit` never-practiced propositions in introduction order: premises before the conclusions
 *  they feed (chain edges among the new set), ties and cycles broken by creation date, then id. */
export function introductionOrder(
	fresh: readonly Pick<GraphNode, "id" | "createdAt">[],
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[],
	limit: number,
): string[] {
	const ids = new Set(fresh.map((n) => n.id));
	const rank = new Map(
		[...fresh].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((n, i) => [n.id, i]),
	);
	const blockers = new Map<string, Set<string>>(fresh.map((n) => [n.id, new Set<string>()]));
	const feeds = new Map<string, Set<string>>(fresh.map((n) => [n.id, new Set<string>()]));
	for (const chain of chains) {
		if (!ids.has(chain.conclusion)) continue;
		for (const premise of chain.premises) {
			if (!ids.has(premise) || premise === chain.conclusion) continue;
			blockers.get(chain.conclusion)!.add(premise);
			feeds.get(premise)!.add(chain.conclusion);
		}
	}
	const order: string[] = [];
	const remaining = new Set(ids);
	while (remaining.size > 0 && order.length < limit) {
		let next: string | null = null;
		for (const id of remaining) {
			if (blockers.get(id)!.size > 0) continue;
			if (next === null || rank.get(id)! < rank.get(next)!) next = id;
		}
		// A cycle: release its oldest member.
		if (next === null) for (const id of remaining) if (next === null || rank.get(id)! < rank.get(next)!) next = id;
		remaining.delete(next!);
		order.push(next!);
		for (const conclusion of feeds.get(next!)!) blockers.get(conclusion)!.delete(next!);
	}
	return order;
}

/** Each live target's lines, in LEDGER order (never sorted by time). An unparseable time is skipped. */
export function historiesOf(reviews: readonly ReviewLine[], live: ReadonlySet<string>): Map<string, ReviewLine[]> {
	const history = new Map<string, ReviewLine[]>();
	for (const line of reviews) {
		if (Number.isNaN(new Date(line.at).getTime())) continue;
		for (const target of new Set(line.targets)) {
			if (!live.has(target)) continue;
			const list = history.get(target);
			if (list) list.push(line);
			else history.set(target, [line]);
		}
	}
	return history;
}

export function reviewQueue(input: ReviewQueueInput): ReviewQueue {
	const dayStartHour = input.dayStartHour ?? REVIEW_DAY_START_HOUR;
	const sessionSize = input.sessionSize ?? REVIEW_SESSION_SIZE;
	const newPerDay = input.newPerDay ?? FACTORY_NEW_PER_DAY;
	const live = new Set(input.nodes.map((n) => n.id));

	const history = historiesOf(input.reviews, live);

	const dayStart = reviewDayStart(input.now, dayStartHour).getTime();
	const now = input.now.getTime();
	const dueAt: { id: string; due: number }[] = [];
	let introducedToday = 0;
	for (const [id, events] of history) {
		if (new Date(events[0]!.at).getTime() >= dayStart) introducedToday++;
		const due = replay(events, input.scheduler)!.due.getTime();
		if (due <= now) dueAt.push({ id, due });
	}
	const due = dueAt.sort((a, b) => a.due - b.due || a.id.localeCompare(b.id)).map((d) => d.id);

	const allowance = Math.max(0, newPerDay - introducedToday);
	const fresh = input.nodes.filter((n) => !history.has(n.id));
	const newAvailable = allowance === 0 ? [] : introductionOrder(fresh, input.chains, allowance);
	return { due, newAvailable, picks: [...due, ...newAvailable].slice(0, sessionSize) };
}
