import type { ProposalDraft } from "./extract";
import type { HarvestItem } from "./types";

export interface Proposal {
	id: string;
	title: string;
	why: string;
	kind: ProposalDraft["kind"];
	prereqOf: string | null;
	firstSeen: string;
	lastSeen: string;
	nItems: number;
	nProjects: number;
	rankScore: number | null;
	status: "proposed" | "accepted" | "dismissed" | "merged";
	mergedInto: string | null;
	evidenceIds: string[];
}

/** `review` means the judge gave no decision. K4 binds this to the judge's 3-level score. */
export type Alignment = "same" | "related" | "different" | "review";
export type Aligner = (existing: Proposal, draft: ProposalDraft) => Promise<Alignment>;

export interface MergeReview {
	draftTitle: string;
	existingId: string | null;
	reason: "related" | "undecided" | "multiple-same";
}

const STOP_WORDS = new Set(["a", "an", "and", "the", "of", "to", "in", "on", "for", "with", "is", "are", "how", "why", "what", "your", "using"]);

function tokens(title: string): Set<string> {
	return new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== "" && !STOP_WORDS.has(t)));
}

function byAge(a: Proposal, b: Proposal): number {
	return a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Counters from the evidence the run can still see; items pruned by source retention keep their id but add nothing. */
function stats(evidenceIds: readonly string[], items: ReadonlyMap<string, HarvestItem>) {
	const found = evidenceIds.flatMap((id) => items.get(id) ?? []);
	const projects = new Set(found.flatMap((item) => (item.project === null ? [] : [item.project])));
	const times = found.map((item) => item.at).sort();
	return { nProjects: projects.size, first: times[0] ?? null, last: times[times.length - 1] ?? null };
}

export async function mergeDrafts(args: {
	existing: readonly Proposal[];
	drafts: readonly ProposalDraft[];
	items: ReadonlyMap<string, HarvestItem>;
	align: Aligner;
	newId: () => string;
	now: () => string;
}): Promise<{ proposals: Proposal[]; reviews: MergeReview[] }> {
	const { items, align, newId, now } = args;
	const working: Proposal[] = args.existing.map((p) => ({ ...p, evidenceIds: [...p.evidenceIds] }));
	const reviews: MergeReview[] = [];

	for (const draft of args.drafts) {
		const draftIds = new Set(draft.evidenceIds);
		const draftTokens = tokens(draft.title);
		const shared = (p: Proposal) => p.evidenceIds.filter((id) => draftIds.has(id)).length;
		// Spec step 6: only pairs that could match reach the aligner. Evidence overlap keeps the id when a rescan rewords the title.
		const shortlist = working
			.filter((p) => p.status !== "merged")
			.filter((p) => shared(p) > 0 || [...tokens(p.title)].some((t) => draftTokens.has(t)))
			.sort(byAge);

		const answers: { p: Proposal; a: Alignment }[] = [];
		for (const p of shortlist) answers.push({ p, a: await align(p, draft) });

		const same = answers.filter((x) => x.a === "same").map((x) => x.p);
		const undecided = answers.filter((x) => x.a === "review").map((x) => x.p);
		const related = answers.filter((x) => x.a === "related").map((x) => x.p);

		if (same.length > 0) {
			const target = same[0] as Proposal;
			for (const extra of same.slice(1)) reviews.push({ draftTitle: draft.title, existingId: extra.id, reason: "multiple-same" });
			const evidenceIds = [...new Set([...target.evidenceIds, ...draft.evidenceIds])];
			const s = stats(evidenceIds, items);
			target.evidenceIds = evidenceIds;
			target.nItems = evidenceIds.length;
			target.nProjects = Math.max(target.nProjects, s.nProjects);
			if (s.first !== null && s.first < target.firstSeen) target.firstSeen = s.first;
			if (s.last !== null && s.last > target.lastSeen) target.lastSeen = s.last;
			continue;
		}
		if (undecided.length > 0) {
			// Fail closed: neither append nor merge; a later run retries.
			for (const p of undecided) reviews.push({ draftTitle: draft.title, existingId: p.id, reason: "undecided" });
			continue;
		}
		if (related.length > 0) {
			const best = [...related].sort((a, b) => shared(b) - shared(a) || byAge(a, b))[0] as Proposal;
			reviews.push({ draftTitle: draft.title, existingId: best.id, reason: "related" });
		}
		const evidenceIds = [...draftIds];
		const s = stats(evidenceIds, items);
		const stamp = now();
		working.push({
			id: newId(),
			title: draft.title,
			why: draft.why,
			kind: draft.kind,
			prereqOf: null,
			firstSeen: s.first ?? stamp,
			lastSeen: s.last ?? stamp,
			nItems: evidenceIds.length,
			nProjects: s.nProjects,
			rankScore: null,
			status: "proposed",
			mergedInto: null,
			evidenceIds,
		});
	}
	return { proposals: working, reviews };
}
