import { clipSnippet } from "./egress";
import { topoOrder } from "./order";
import type { Proposal } from "./proposals";
import type { Decision, SeedStore, Verdict } from "./store";
import type { AllowEgress, HarvestItem } from "./types";

export type Opening = { kind: "ok"; text: string } | { kind: "no-evidence" } | { kind: "opted-out" };

/**
 * The stored opening for a teaching chat (spec step 12). The learner sends it to the teaching model, so it is held to the
 * judge's rule: every evidence item must pass egress, because the title was written from all of them.
 */
export function firstMessage(p: Pick<Proposal, "title" | "evidenceIds">, items: ReadonlyMap<string, HarvestItem>, allowEgress: AllowEgress): Opening {
	const evidence = p.evidenceIds.flatMap((id) => items.get(id) ?? []).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
	const first = evidence[0];
	if (!first) return { kind: "no-evidence" };
	if (!evidence.every((i) => allowEgress(i.project))) return { kind: "opted-out" };
	return { kind: "ok", text: `I keep running into ${p.title} (for example: ${clipSnippet(first.textRedacted)}). Teach me it from first principles, then check my understanding.` };
}

export interface PanelRow {
	id: string;
	title: string;
	why: string;
	kind: Proposal["kind"];
	/** Up to three redacted snippets, as `list` prints them. */
	evidence: string[];
	/** Title of the shown proposal this one should come before. */
	prerequisiteFor: string | null;
	/** "learn" when the owner already chose it; null when only the pipeline proposed it. */
	label: "learn" | null;
	/** False when accept would refuse: no evidence, or some of it is opted out. */
	acceptable: boolean;
}

/** Open = still proposed, not accepted, and either chosen by the owner (learn) or unlabelled with a propose/review decision. A know or skip label closes it. */
const isOpen = (status: Proposal["status"], accepted: boolean, label: Verdict | undefined, decision: Decision | undefined) =>
	status === "proposed" && !accepted && (label === "learn" || (label === undefined && (decision === "propose" || decision === "review")));

function snapshot(store: SeedStore) {
	const decisions = new Map(store.ranks().map((r) => [r.proposalId, r.decision]));
	const labels = new Map(store.labels().map((l) => [l.proposalId, l.verdict]));
	const accepts = new Map(store.accepts().map((a) => [a.proposalId, a]));
	const proposals = store.loadProposals();
	const open = (p: Proposal) => isOpen(p.status, accepts.has(p.id), labels.get(p.id), decisions.get(p.id));
	return { labels, accepts, proposals, open };
}

/** What the home panel offers, in prerequisite order then rank. Reads the store only: nothing here reaches a model. */
export function panelRows(store: SeedStore, allowEgress: AllowEgress): PanelRow[] {
	const { labels, proposals, open } = snapshot(store);
	const items = new Map(store.items().map((i) => [i.id, i]));
	const shown = proposals.filter(open);
	const byId = new Map(shown.map((p) => [p.id, p]));
	const edges = shown.flatMap((p) => (p.prereqOf === null ? [] : [{ from: p.id, to: p.prereqOf, p: 1 }]));
	const order = topoOrder(
		shown.map((p) => p.id),
		edges,
		new Map(shown.map((p) => [p.id, p.rankScore ?? Number.NEGATIVE_INFINITY])),
	);
	return order.map((id) => {
		const p = byId.get(id)!;
		return {
			id,
			title: p.title,
			why: p.why,
			kind: p.kind,
			evidence: p.evidenceIds.slice(0, 3).flatMap((eid) => {
				const item = items.get(eid);
				return item ? [clipSnippet(item.textRedacted).slice(0, 120).replace(/\s+/g, " ")] : [];
			}),
			prerequisiteFor: p.prereqOf === null ? null : (byId.get(p.prereqOf)?.title ?? null),
			label: labels.get(id) === "learn" ? "learn" : null,
			acceptable: firstMessage(p, items, allowEgress).kind === "ok",
		};
	});
}

export type AcceptResult = { kind: "accepted"; firstMessage: string } | { kind: "not-found" } | { kind: "not-open" } | { kind: "no-evidence" } | { kind: "opted-out" };

/**
 * Records the accept for a chat the caller created through POST /api/chats. The store writes the accept, the "learn"
 * label and the status flip in one transaction, so every accept is a label the calibration reads.
 * A retry with the same chat returns the stored message instead of a second accept.
 */
export function acceptProposal(store: SeedStore, allowEgress: AllowEgress, input: { proposalId: string; chatId: string; at: string }): AcceptResult {
	const { accepts, proposals, open } = snapshot(store);
	const p = proposals.find((x) => x.id === input.proposalId);
	if (!p) return { kind: "not-found" };
	const prior = accepts.get(p.id);
	if (prior) return prior.chatId === input.chatId ? { kind: "accepted", firstMessage: prior.firstMessage } : { kind: "not-open" };
	if (!open(p)) return { kind: "not-open" };
	const opening = firstMessage(p, new Map(store.items().map((i) => [i.id, i])), allowEgress);
	if (opening.kind !== "ok") return opening;
	try {
		store.saveAccept({ proposalId: p.id, chatId: input.chatId, firstMessage: opening.text, at: input.at });
	} catch (error) {
		// a concurrent accept won the primary key
		if (store.accepts().some((a) => a.proposalId === p.id)) return { kind: "not-open" };
		throw error;
	}
	return { kind: "accepted", firstMessage: opening.text };
}

export type DismissResult = { kind: "dismissed" } | { kind: "not-found" } | { kind: "not-open" };

/** A dismiss is a label (know or skip), not a status: the CLI `label` command can still change it. */
export function dismissProposal(store: SeedStore, input: { proposalId: string; verdict: Exclude<Verdict, "learn">; at: string }): DismissResult {
	const { proposals, open } = snapshot(store);
	const p = proposals.find((x) => x.id === input.proposalId);
	if (!p) return { kind: "not-found" };
	if (!open(p)) return { kind: "not-open" };
	store.setLabel(p.id, input.verdict, input.at);
	return { kind: "dismissed" };
}
