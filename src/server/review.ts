/**
 * SCHEDULED PRACTICE, the server half. The review ledger is fed from SAVED practice records only, never from a
 * tool's mid-turn execute: a turn that fails before persistTurn leaves no review behind a transcript that lost it.
 * Sync points: practice-turn settlement (chat-handler onFinish), the idle dismiss route, chat deletion (the
 * ledger outlives the chat), and a lazy whole-store backfill on the first queue read per process.
 * Every sync is ONE `graphStore.transact`, deduped by review id (chatId:problemCallId) against the ledger read
 * INSIDE it, so a throw mid-sync leaves no lines and a re-sync appends nothing. Scheduler knobs are the factory's.
 */

import { getGraph } from "../core/graph.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import { practiceReviewsOf, reviewQueue } from "../core/srs/index.ts";
import { stores } from "./stores.ts";

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

/** GET /api/review's payload: the queue over the live graph. */
export function reviewSummary(
	now: Date = new Date(),
	deps: Pick<GraphStore, "readNodes" | "readChains" | "readReviews"> = stores.graphStore,
): ReviewSummary {
	const graph = getGraph(deps);
	const queue = reviewQueue({ reviews: deps.readReviews(), nodes: graph.nodes, chains: graph.chains, now });
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
