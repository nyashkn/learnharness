/**
 * SCHEDULED PRACTICE, the server half. The review ledger is fed from SAVED practice records only, never from a
 * tool's mid-turn execute: a turn that fails before persistTurn leaves no review behind a transcript that lost it.
 * Sync points: practice-turn settlement (chat-handler onFinish), the idle dismiss route, chat deletion (the
 * ledger outlives the chat), and a lazy whole-store backfill on the first queue read per process.
 * Every sync is ONE `graphStore.transact`, deduped by review id (chatId:problemCallId) against the ledger read
 * INSIDE it, so a throw mid-sync leaves no lines and a re-sync appends nothing. Scheduler knobs are the factory's.
 */

import type { Cluster } from "../core/contracts.ts";
import { getGraph } from "../core/graph.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import type { ReviewSettings } from "../core/settings.ts";
import { formatReviewBrief, reviewBriefOf, practiceReviewsOf, reviewQueue, reviewSchedule, type ReviewCardFacts, type ReviewSchedule } from "../core/srs/index.ts";
import { graphView } from "./graph.ts";
import { effectiveSettings, stores } from "./stores.ts";

type SyncDeps = { chatStore: Pick<ChatStore, "getChat" | "listChats">; graphStore: Pick<GraphStore, "transact" | "readReviews" | "appendReview"> };

/** Append one practice chat's not-yet-logged reviews. Teach chats and unknown ids are no-ops. Returns how many lines were appended. */
export function syncChatReviews(chatId: string, deps: SyncDeps = stores): number {
	const record = deps.chatStore.getChat(chatId);
	if (!record || record.kind !== "practice") return 0;
	const found = practiceReviewsOf(chatId, record.messages);
	if (found.length === 0) return 0;
	return deps.graphStore.transact(`review chat:${chatId}`, () => {
		const logged = new Set(deps.graphStore.readReviews().map((r) => r.id));
		const fresh = found.filter((r) => !logged.has(r.id));
		for (const line of fresh) deps.graphStore.appendReview(line);
		return fresh.length;
	});
}

/** The settlement/route/deletion seam: a review sync must never fail the work it rides on. Log and move on (the next backfill catches up). */
export function syncChatReviewsSafely(chatId: string): void {
	try {
		syncChatReviews(chatId);
	} catch (err) {
		console.error(`[chat ${chatId}] review sync failed:`, err);
	}
}

/** Fold every practice chat into the ledger (idempotent), in one transaction. */
export function backfillReviews(deps: SyncDeps = stores): number {
	const found = deps.chatStore.listChats().flatMap((summary) => {
		if (summary.kind !== "practice") return [];
		const record = deps.chatStore.getChat(summary.id);
		return record ? practiceReviewsOf(summary.id, record.messages) : [];
	});
	if (found.length === 0) return 0;
	return deps.graphStore.transact("review backfill", () => {
		const logged = new Set(deps.graphStore.readReviews().map((r) => r.id));
		const fresh = found.filter((r) => !logged.has(r.id));
		for (const line of fresh) deps.graphStore.appendReview(line);
		return fresh.length;
	});
}

interface LhReviewGlobal {
	__lhReviewBackfilled?: boolean;
}

/** The once-per-process backfill (globalThis-backed so separate Next module entries share it). A failure is logged and retried on the next read. */
export function ensureReviewBackfill(): void {
	const g = globalThis as typeof globalThis & LhReviewGlobal;
	if (g.__lhReviewBackfilled) return;
	try {
		backfillReviews();
		g.__lhReviewBackfilled = true;
	} catch (err) {
		console.error("review backfill failed:", err);
	}
}

/** The history brief's session-context lines for a practice session's picks (chat creation). Backfills first, so
 *  the ledger holds every saved practice chat. A brief must never fail the creation it rides on: log and start
 *  the session without one. */
export function reviewBriefLines(
	pickIds: readonly string[],
	now: Date = new Date(),
	deps: Pick<GraphStore, "readReviews"> = stores.graphStore,
): string[] {
	try {
		ensureReviewBackfill();
		const scheduler = effectiveSettings().review;
		return formatReviewBrief(reviewBriefOf({ reviews: deps.readReviews(), pickIds, now, scheduler }));
	} catch (err) {
		console.error("review brief failed:", err);
		return [];
	}
}

export interface ReviewPick {
	id: string;
	name: string;
	statement: string;
}

export interface ReviewSummary {
	/** Practiced propositions due now. */
	dueCount: number;
	/** Never-practiced propositions today's allowance still admits. */
	newCount: number;
	/** The next review session's propositions (due first, then new). */
	picks: ReviewPick[];
}

type ReviewReadDeps = Pick<GraphStore, "readNodes" | "readChains" | "readReviews">;

/** GET /api/review's payload: the queue over the live graph, scheduled with the resolved review settings. */
export function reviewSummary(
	now: Date = new Date(),
	deps: ReviewReadDeps = stores.graphStore,
	review: Required<ReviewSettings> = effectiveSettings().review,
): ReviewSummary {
	const graph = getGraph(deps);
	const queue = reviewQueue({
		reviews: deps.readReviews(),
		nodes: graph.nodes,
		chains: graph.chains,
		now,
		newPerDay: review.newPerDay,
		scheduler: review,
	});
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	return {
		dueCount: queue.due.length,
		newCount: queue.newAvailable.length,
		picks: queue.picks.map((id) => {
			const node = byId.get(id)!;
			return { id, name: node.name, statement: node.statement };
		}),
	};
}

/** The heatmap window: 26 weeks either side of today. */
export const REVIEW_SCHEDULE_WINDOW_DAYS = 26 * 7;

/** A due card with the live proposition's name and statement. */
export type ReviewScheduleCard = ReviewCardFacts & { name: string; statement: string };

/** One never-practiced proposition in the new-problems block. */
export interface NewProblem extends ReviewPick {
	/** In today's allowance (the schedule's newToday). */
	today: boolean;
}

/** One topic of the new-problems block (Settings > Review). */
export interface NewProblemTopic {
	/** The labeled graph region's id; null for Other. */
	id: string | null;
	/** The region's label; null for Other. */
	label: string | null;
	/** Its problems, in introduction order. */
	problems: NewProblem[];
}

/**
 * The new backlog grouped by topic. A topic is a LABELED graph region (the snapshot's clusters with a label:
 * "graph regions only"); everything else falls into Other. Topics sort by count desc, ties by label then id;
 * Other always last. Problems keep introduction order.
 */
export function groupNewBacklog(
	backlog: readonly ReviewPick[],
	today: readonly string[],
	regions: readonly Pick<Cluster, "id" | "label" | "members">[],
): NewProblemTopic[] {
	const todaySet = new Set(today);
	const regionOf = new Map<string, Pick<Cluster, "id" | "label">>();
	for (const region of regions) {
		if (region.label === null) continue;
		for (const member of region.members) regionOf.set(member, region);
	}
	const topics = new Map<string, NewProblemTopic>();
	const other: NewProblemTopic = { id: null, label: null, problems: [] };
	for (const pick of backlog) {
		const problem = { ...pick, today: todaySet.has(pick.id) };
		const region = regionOf.get(pick.id);
		if (!region) {
			other.problems.push(problem);
			continue;
		}
		let topic = topics.get(region.id);
		if (!topic) {
			topic = { id: region.id, label: region.label, problems: [] };
			topics.set(region.id, topic);
		}
		topic.problems.push(problem);
	}
	const named = [...topics.values()].sort(
		(a, b) => b.problems.length - a.problems.length || a.label!.localeCompare(b.label!) || a.id!.localeCompare(b.id!),
	);
	return other.problems.length > 0 ? [...named, other] : named;
}

/** GET /api/review/schedule's payload: the Settings > Review heatmap and its new-problems block. */
export interface ReviewScheduleView extends Omit<ReviewSchedule, "future" | "newToday" | "newBacklog"> {
	future: { date: string; due: ReviewScheduleCard[] }[];
	newToday: ReviewPick[];
	newBacklog: NewProblemTopic[];
}

export function reviewScheduleView(
	now: Date = new Date(),
	deps: ReviewReadDeps = stores.graphStore,
	review: Required<ReviewSettings> = effectiveSettings().review,
	regions: () => readonly Pick<Cluster, "id" | "label" | "members">[] = () => graphView().clusters,
): ReviewScheduleView {
	const graph = getGraph(deps);
	const schedule = reviewSchedule({
		reviews: deps.readReviews(),
		nodes: graph.nodes,
		chains: graph.chains,
		now,
		newPerDay: review.newPerDay,
		scheduler: review,
		pastDays: REVIEW_SCHEDULE_WINDOW_DAYS,
		futureDays: REVIEW_SCHEDULE_WINDOW_DAYS,
	});
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const named = (id: string) => {
		const node = byId.get(id)!;
		return { name: node.name, statement: node.statement };
	};
	return {
		...schedule,
		future: schedule.future.map((day) => ({ ...day, due: day.due.map((card) => ({ ...card, ...named(card.id) })) })),
		newToday: schedule.newToday.map((id) => ({ id, ...named(id) })),
		newBacklog: groupNewBacklog(
			schedule.newBacklog.map((id) => ({ id, ...named(id) })),
			schedule.newToday,
			regions(),
		),
	};
}
