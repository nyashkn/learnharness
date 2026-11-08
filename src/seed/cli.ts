import { Type } from "typebox";
import { Value } from "typebox/value";
import { clipSnippet } from "./egress";
import { extractDraft, type ProposalDraft } from "./extract";
import type { JudgeOutcome, JudgePort, JudgeRequest, Question } from "./judge/port";
import { mergeDrafts, type Aligner } from "./proposals";
import { rankProposal } from "./rank";
import { redact } from "./redact";
import { findRepeats } from "./signals";
import { harvest } from "./sources/harvest";
import type { Decision, ReviewRow, SeedStore, Verdict } from "./store";
import type { AllowEgress, HarvestItem, LlmPort, SessionSource } from "./types";

/** Loaded from scripts/seed-config.json; no number lives in code. */
export interface SeedPolicy {
	/** False until the owner's labels (GK) have calibrated the rank values. */
	calibrated: boolean;
	recencyHalfLifeDays: number;
	goalWeight: number;
	minMentions: number;
	learnableTau: number;
}

/** All I/O arrives here: src/seed touches no process, console, network or database of its own. */
export interface CliDeps {
	store: SeedStore;
	sources: readonly SessionSource[];
	judge: JudgePort;
	llm: LlmPort;
	allowEgress: AllowEgress;
	fetch: typeof fetch;
	baseUrl: string;
	now: () => string;
	newId: () => string;
	out: (line: string) => void;
	policy: SeedPolicy;
}

export const DESKTOP_NOTE =
	"Desktop: the desktop server needs a per-launch secret and a random port, so `propose` cannot reach it. On desktop, accept goes through the Home panel (K5 only). This CLI works against `pnpm run dev`.";

export const HELP = [
	"pnpm run seed -- <command> [--judge clef|typesafe|openrouter|configured-llm] [--url <dev server>]",
	"",
	"  scan [--goals \"<text>\"]   harvest, redact, screen, propose and rank teaching sessions",
	"  list                      show proposed and review sessions with evidence",
	"  label <id> learn|know|skip",
	"  propose                   start a titled chat for every `learn` label (POST /api/chats {title}); the first message is stored for the Home panel",
	"  report                    calibration report from your labels",
	"",
	DESKTOP_NOTE,
	"Redaction is always on. Egress is on for every project unless listed in <data dir>/seed-optout.txt.",
].join("\n");

export type Parsed =
	| { kind: "help" }
	| { kind: "error"; message: string }
	| { kind: "scan"; goals: string | null }
	| { kind: "list" }
	| { kind: "report" }
	| { kind: "propose" }
	| { kind: "label"; id: string; verdict: Verdict };

const VERDICTS: readonly string[] = ["learn", "know", "skip"];

export function parseCommand(rawArgv: readonly string[]): Parsed {
	const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
	const [command, ...rest] = argv;
	if (command === undefined || command === "--help" || command === "-h" || command === "help") return { kind: "help" };
	if (rest.includes("--help") || rest.includes("-h")) return { kind: "help" };
	const noArgs = (parsed: Parsed): Parsed => (rest.length === 0 ? parsed : { kind: "error", message: `${command} takes no arguments` });
	switch (command) {
		case "list":
			return noArgs({ kind: "list" });
		case "report":
			return noArgs({ kind: "report" });
		case "propose":
			return noArgs({ kind: "propose" });
		case "scan": {
			if (rest.length === 0) return { kind: "scan", goals: null };
			if (rest.length === 2 && rest[0] === "--goals" && rest[1]!.trim() !== "") return { kind: "scan", goals: redact(rest[1]!) };
			return { kind: "error", message: 'scan takes only --goals "<text>"' };
		}
		case "label": {
			const [id, verdict] = rest;
			if (rest.length !== 2 || id === undefined || verdict === undefined || !VERDICTS.includes(verdict)) {
				return { kind: "error", message: "usage: label <proposalId> learn|know|skip" };
			}
			return { kind: "label", id, verdict: verdict as Verdict };
		}
		default:
			return { kind: "error", message: `unknown command: ${command}` };
	}
}

const UNCALIBRATED = "note: rank values are uncalibrated until the owner's labels (GK) are in.";

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
	const parsed = parseCommand(argv);
	switch (parsed.kind) {
		case "help":
			deps.out(HELP);
			return 0;
		case "error":
			deps.out(parsed.message);
			deps.out(HELP);
			return 2;
		case "scan":
			if (!deps.policy.calibrated) deps.out(UNCALIBRATED);
			return scan(deps, parsed.goals);
		case "list":
			if (!deps.policy.calibrated) deps.out(UNCALIBRATED);
			return list(deps);
		case "label":
			return label(deps, parsed.id, parsed.verdict);
		case "propose":
			return propose(deps);
		case "report":
			if (!deps.policy.calibrated) deps.out(UNCALIBRATED);
			return report(deps);
	}
}

// ---- pure helpers -----------------------------------------------------------------------------------------------

export interface Edge {
	from: string;
	to: string;
	/** P(from must come before to). */
	p: number;
}

const edgeKey = (e: Edge) => `${e.from}\u0000${e.to}`;

function findCycle(edges: readonly Edge[]): Edge[] | null {
	const adj = new Map<string, Edge[]>();
	for (const e of [...edges].sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : 1))) adj.set(e.from, [...(adj.get(e.from) ?? []), e]);
	const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();
	const state = new Map<string, 1 | 2>();
	const path: Edge[] = [];
	const visit = (n: string): Edge[] | null => {
		state.set(n, 1);
		for (const e of adj.get(n) ?? []) {
			const s = state.get(e.to);
			if (s === 1) {
				const start = path.findIndex((x) => x.from === e.to);
				return [...(start < 0 ? [] : path.slice(start)), e];
			}
			if (s === undefined) {
				path.push(e);
				const cycle = visit(e.to);
				if (cycle) return cycle;
				path.pop();
			}
		}
		state.set(n, 2);
		return null;
	};
	for (const n of nodes) {
		if (state.has(n)) continue;
		const cycle = visit(n);
		if (cycle) return cycle;
	}
	return null;
}

/** Spec step 10: while a cycle exists, drop its lowest-probability edge (ties: smallest key). */
export function breakCycles(edges: readonly Edge[]): Edge[] {
	let live = [...edges];
	for (;;) {
		const cycle = findCycle(live);
		if (!cycle) return live;
		const drop = cycle.reduce((m, e) => (e.p < m.p || (e.p === m.p && edgeKey(e) < edgeKey(m)) ? e : m));
		live = live.filter((e) => e !== drop);
	}
}

/** from-before-to order. Among ready nodes the higher priority goes first. Nodes stuck in a leftover cycle still come out, by priority. */
export function topoOrder(ids: readonly string[], edges: readonly Edge[], priority: ReadonlyMap<string, number>): string[] {
	const remaining = new Set(ids);
	const live = edges.filter((e) => remaining.has(e.from) && remaining.has(e.to) && e.from !== e.to);
	const rank = (id: string) => priority.get(id) ?? Number.NEGATIVE_INFINITY;
	const best = (pool: string[]) => pool.reduce((m, id) => (rank(id) > rank(m) || (rank(id) === rank(m) && id < m) ? id : m));
	const order: string[] = [];
	while (remaining.size > 0) {
		const ready = [...remaining].filter((id) => !live.some((e) => e.to === id && remaining.has(e.from)));
		const next = best(ready.length > 0 ? ready : [...remaining]);
		remaining.delete(next);
		order.push(next);
	}
	return order;
}

export interface LabelledRow {
	id: string;
	verdict: Verdict;
	/** null: the proposal was never ranked. */
	score: number | null;
}

export interface CalibrationStep {
	tau: number;
	threshold: number;
	predicted: number;
	precision: number | null;
	recall: number | null;
}

/** Threshold = sorted[floor(tau*(n-1))]; "above" is strictly greater. Only ranked rows take part. Median split for disagreements. */
export function calibration(rows: readonly LabelledRow[]) {
	const scored = rows.flatMap((r) => (r.score === null ? [] : [{ ...r, score: r.score }]));
	const sorted = scored.map((r) => r.score).sort((a, b) => a - b);
	const n = sorted.length;
	const learn = scored.filter((r) => r.verdict === "learn").length;
	const at = (tenths: number) => sorted[Math.floor((tenths * (n - 1)) / 10)] as number;
	const steps: CalibrationStep[] = [];
	if (n > 0) {
		for (let i = 0; i <= 10; i++) {
			const threshold = at(i);
			const picked = scored.filter((r) => r.score > threshold);
			const tp = picked.filter((r) => r.verdict === "learn").length;
			steps.push({ tau: i / 10, threshold, predicted: picked.length, precision: picked.length === 0 ? null : tp / picked.length, recall: learn === 0 ? null : tp / learn });
		}
	}
	const median = n > 0 ? at(5) : null;
	return {
		steps,
		highRankNotLearn: median === null ? [] : scored.filter((r) => r.score > median && r.verdict !== "learn").map((r) => r.id),
		lowRankLearn: median === null ? [] : scored.filter((r) => r.score <= median && r.verdict === "learn").map((r) => r.id),
	};
}

// ---- scan ---------------------------------------------------------------------------------------------------------

const SUMMARY_SOURCES: ReadonlySet<string> = new Set(["omp-recap", "omp-memory", "signet-summary"]);
const TOPIC_BATCH = 200;
const PREREQ_TOP = 30;
const DAY_MS = 86_400_000;

const TopicsSchema = Type.Object({ topics: Type.Array(Type.String()) });
const noul = (id: string, instructions: string): Question => ({ id, kind: "noul", instructions });

const SCREEN_QUESTIONS: readonly Question[] = [
	noul("concept", "Does the learner ask why something works, or what a concept means?"),
	noul("confusion", "Does the learner show confusion or a wrong assumption?"),
	noul("standalone", "Is this a standalone algorithm, maths or concept question?"),
];

const DECISION_INSTRUCTIONS =
	"Should this topic become a proposed teaching session? Requirements: the learner met it in at least 2 prompts; it is not already covered by an accepted proposal. Prefer fewer, higher-value sessions. Choose ask_user when you cannot tell.";

/** The judge could not run because no token is configured: nothing else will work either. */
class NoTokenError extends Error {}

const noulOf = (o: JudgeOutcome & { kind: "answered" }, id: string): number => {
	const a = o.answers[id];
	return a?.kind === "noul" ? a.probability : Number.NaN;
};

const topProbability = (probabilities: Record<string, number>) => Math.max(...Object.values(probabilities));

const round2 = (n: number) => Math.round(n * 100) / 100;

async function scan(deps: CliDeps, goals: string | null): Promise<number> {
	const { store, allowEgress, llm, policy, out, now } = deps;
	const stamp = now();
	const reviews: Omit<ReviewRow, "id" | "at">[] = [];
	const aggregate = new Map<string, string[]>();
	const note = (reason: string, id: string) => aggregate.set(reason, [...(aggregate.get(reason) ?? []), id]);

	const ask = async (req: JudgeRequest): Promise<JudgeOutcome> => {
		const o = await deps.judge.ask(req);
		if (o.kind === "no-decision" && o.reason === "no-token") throw new NoTokenError();
		return o;
	};

	try {
		// 1. harvest
		const harvested: HarvestItem[] = [];
		for await (const item of harvest(deps.sources)) harvested.push(item);
		store.upsertItems(harvested);
		for (const s of deps.sources) if (s.stats.skipped > 0) out(`${s.name}: skipped ${s.stats.skipped} malformed rows`);
		const stored = store.items();
		store.markRepeats([...findRepeats(stored.map((i) => ({ id: i.id, sessionId: i.sessionId, text: i.textRedacted })))]);
		const items = store.items();
		const byId = new Map(items.map((i) => [i.id, i]));
		out(`harvested ${harvested.length} items (${items.length} stored)`);

		// 2. screen
		const screen = new Map<string, { concept: number; confusion: number }>();
		const kept: HarvestItem[] = [];
		let denied = 0;
		const candidates = items.filter((i) => i.signal !== null || SUMMARY_SOURCES.has(i.source));
		for (const item of candidates) {
			if (!allowEgress(item.project)) {
				denied++;
				continue;
			}
			const o = await ask({ projects: [item.project], counts: { items: 1 }, snippets: [clipSnippet(item.textRedacted)], questions: SCREEN_QUESTIONS });
			if (o.kind === "no-decision") {
				if (o.reason === "egress-denied") denied++;
				else note(`screen-${o.reason}`, item.id);
				continue;
			}
			const concept = noulOf(o, "concept");
			const confusion = noulOf(o, "confusion");
			const learnable = Math.max(concept, confusion, noulOf(o, "standalone"));
			screen.set(item.id, { concept, confusion });
			if (learnable >= policy.learnableTau) kept.push(item);
		}
		out(`screened ${candidates.length} candidates: ${kept.length} learnable, ${denied} egress-denied`);

		// 3. topic
		const topics = new Map<string, string>();
		for (let i = 0; i < kept.length; i += TOPIC_BATCH) {
			const batch = kept.slice(i, i + TOPIC_BATCH).filter((item) => allowEgress(item.project));
			if (batch.length === 0) continue;
			const prompt = [
				"Name the distinct teachable topics in the notes below. Return short topic names. The topics may be code or not: algorithms, maths, concepts.",
				"",
				...batch.map((item) => `- ${clipSnippet(item.textRedacted)}`),
			].join("\n");
			let reply: unknown;
			try {
				reply = await llm.complete(prompt, TopicsSchema);
			} catch {
				for (const item of batch) note("topic-llm-failed", item.id);
				continue;
			}
			if (!Value.Check(TopicsSchema, reply)) {
				for (const item of batch) note("topic-invalid-output", item.id);
				continue;
			}
			for (const t of reply.topics) if (t.trim() !== "" && !topics.has(t.trim().toLowerCase())) topics.set(t.trim().toLowerCase(), t.trim());
		}
		const topicList = [...topics.values()];
		const clusters = new Map<string, HarvestItem[]>();
		if (topicList.length > 0) {
			const options: Record<string, string | null> = Object.fromEntries(topicList.map((t, i) => [`t${i}`, t]));
			options.none = "no teachable concept";
			const question: Question = { id: "topic", kind: "choice", instructions: "Which topic does this note belong to?", options };
			for (const item of kept) {
				if (!allowEgress(item.project)) continue;
				const o = await ask({ projects: [item.project], counts: { items: 1, topics: topicList.length }, snippets: [clipSnippet(item.textRedacted)], questions: [question] });
				if (o.kind === "no-decision") {
					if (o.reason === "egress-denied") denied++;
					else note(`topic-${o.reason}`, item.id);
					continue;
				}
				const a = o.answers.topic;
				if (a?.kind !== "choice") continue;
				// Spec step 11: confidence first, before the choice is read.
				if (topProbability(a.probabilities) < 0.5) {
					note("topic-low-confidence", item.id);
					continue;
				}
				if (a.choice === "none") continue;
				clusters.set(a.choice, [...(clusters.get(a.choice) ?? []), item]);
			}
		}

		// 4. draft titles
		const drafts: ProposalDraft[] = [];
		for (const key of [...clusters.keys()].sort()) {
			const result = await extractDraft(clusters.get(key)!, { llm, allowEgress });
			if (result.kind === "draft") drafts.push(result.draft);
			else reviews.push({ proposalId: null, reason: `extract-${result.reason}`, detail: topicOf(topicList, key) });
		}

		// 5. align and merge
		const projectsOf = (ids: readonly string[]) => [...new Set(ids.map((id) => byId.get(id)?.project ?? null))];
		const align: Aligner = async (existing, draft) => {
			const o = await ask({
				projects: [...new Set([...projectsOf(existing.evidenceIds), ...projectsOf(draft.evidenceIds)])],
				counts: { existingItems: existing.nItems, draftItems: draft.evidenceIds.length },
				snippets: [clipSnippet(`A: ${existing.title}`), clipSnippet(`B: ${draft.title}`)],
				questions: [
					{ id: "relation", kind: "score", instructions: "How alike are the teaching topics A and B?", levels: ["different", "related", "same"] },
					noul("same", "Do these describe the same teaching topic?"),
				],
			});
			if (o.kind === "no-decision") return "review";
			const score = o.answers.relation;
			if (score?.kind !== "score") return "review";
			if (score.score < 0.5) return "different";
			if (score.score < 1.5) return "related";
			return noulOf(o, "same") < 0.5 ? "review" : "same";
		};
		const merged = await mergeDrafts({ existing: store.loadProposals(), drafts, items: byId, align, newId: deps.newId, now });
		for (const r of merged.reviews) reviews.push({ proposalId: r.existingId, reason: `merge-${r.reason}`, detail: r.draftTitle });
		const proposals = merged.proposals;
		store.saveProposals(proposals);

		// 6. rank
		const targets = proposals.filter((p) => p.status === "proposed");
		const state = new Map<string, { decision: Decision; dims: Record<string, unknown> }>();
		for (const p of targets) {
			p.prereqOf = null;
			p.rankScore = null;
			const ev = p.evidenceIds.flatMap((id) => byId.get(id) ?? []);
			const gaps = ev.flatMap((i) => {
				const s = screen.get(i.id);
				return s ? [Math.max(s.concept, s.confusion)] : [];
			});
			const gap = gaps.length === 0 ? null : gaps.reduce((a, b) => a + b, 0) / gaps.length;
			let goalRelevance: number | null = 0; // no goals given: neutral, not a failure
			if (goals !== null) {
				const o = await ask({
					projects: projectsOf(p.evidenceIds),
					counts: { items: p.nItems },
					snippets: [clipSnippet(`Goals: ${goals}`), clipSnippet(`${p.title}: ${p.why}`)],
					questions: [noul("goal", "Is this teaching topic relevant to the learner's goals?")],
				});
				goalRelevance = o.kind === "answered" ? noulOf(o, "goal") : null;
			}
			const days = (Date.parse(stamp) - Date.parse(p.lastSeen)) / DAY_MS;
			const result = Number.isFinite(days)
				? rankProposal({ gap, nItems: p.nItems, nProjects: p.nProjects, daysSinceLast: days, goalRelevance }, policy)
				: ({ kind: "review", reason: "unreadable timestamp" } as const);
			if (result.kind === "review") {
				state.set(p.id, { decision: "review", dims: { reason: result.reason } });
				reviews.push({ proposalId: p.id, reason: "rank-review", detail: result.reason });
				continue;
			}
			p.rankScore = result.score;
			state.set(p.id, { decision: "none", dims: { ...result.dimensions, score: result.score } });
		}

		// 7. decide
		const decide = new Map<string, Decision>();
		for (const p of targets) {
			if (state.get(p.id)!.decision === "review") continue;
			let decision: Decision;
			if (p.nItems < 2) decision = "skip";
			else {
				const snippets = [clipSnippet(`${p.title}: ${p.why}`), ...p.evidenceIds.slice(0, 3).flatMap((id) => (byId.get(id) ? [clipSnippet(byId.get(id)!.textRedacted)] : []))];
				const o = await ask({
					projects: projectsOf(p.evidenceIds),
					counts: { items: p.nItems, projects: p.nProjects },
					snippets,
					questions: [
						{
							id: "decision",
							kind: "choice",
							instructions: DECISION_INSTRUCTIONS,
							options: { propose: "propose a session", skip: "do not propose", ask_user: "ask the learner", none: "no teachable topic" },
						},
					],
				});
				const a = o.kind === "answered" ? o.answers.decision : undefined;
				if (a?.kind !== "choice" || topProbability(a.probabilities) < 0.5 || a.choice === "ask_user") {
					decision = "review";
					reviews.push({ proposalId: p.id, reason: "decide-review", detail: a?.kind === "choice" ? `choice ${a.choice}` : "no judge decision" });
				} else decision = a.choice as Decision;
			}
			state.get(p.id)!.decision = decision;
			decide.set(p.id, decision);
		}

		// 8. verify evidence
		for (const p of targets) {
			if (decide.get(p.id) !== "propose") continue;
			const keep: string[] = [];
			let undecided = 0;
			for (const id of p.evidenceIds) {
				const item = byId.get(id);
				if (!item) {
					keep.push(id);
					continue;
				}
				const o = await ask({
					projects: [item.project],
					counts: { items: 1 },
					snippets: [clipSnippet(item.textRedacted)],
					questions: [noul("confused", `The learner was confused about ${p.title} in this prompt.`)],
				});
				if (o.kind === "no-decision") {
					undecided++;
					keep.push(id);
				} else if (noulOf(o, "confused") >= 0.5) keep.push(id);
			}
			if (undecided > 0) reviews.push({ proposalId: p.id, reason: "verify-no-decision", detail: `${undecided} evidence items kept without verification` });
			p.evidenceIds = keep;
			p.nItems = keep.length;
			p.nProjects = new Set(keep.flatMap((id) => byId.get(id)?.project ?? [])).size;
			// Fewer than 2 prompts left breaks the step 7 requirement, so the same code-first rule applies.
			if (p.nItems < 2) {
				state.get(p.id)!.decision = "skip";
				decide.set(p.id, "skip");
			}
		}

		// 9. prerequisite order
		const top = targets
			.filter((p) => decide.get(p.id) === "propose")
			.sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0) || (a.id < b.id ? -1 : 1))
			.slice(0, PREREQ_TOP);
		const edges: Edge[] = [];
		for (let i = 0; i < top.length; i++) {
			for (let j = i + 1; j < top.length; j++) {
				const a = top[i]!;
				const b = top[j]!;
				const o = await ask({
					projects: [...new Set([...projectsOf(a.evidenceIds), ...projectsOf(b.evidenceIds)])],
					counts: { itemsA: a.nItems, itemsB: b.nItems },
					snippets: [clipSnippet(`A: ${a.title}`), clipSnippet(`B: ${b.title}`)],
					questions: [noul("ab", "To understand B, must a learner already understand A?"), noul("ba", "To understand A, must a learner already understand B?")],
				});
				if (o.kind === "no-decision") continue;
				const ab = noulOf(o, "ab");
				const ba = noulOf(o, "ba");
				if (ab >= 0.5 && ba < 0.5) edges.push({ from: a.id, to: b.id, p: ab });
				else if (ba >= 0.5 && ab < 0.5) edges.push({ from: b.id, to: a.id, p: ba });
			}
		}
		for (const e of breakCycles(edges)) {
			const owner = proposals.find((p) => p.id === e.from)!;
			const current = edges.find((x) => x.from === owner.id && x.to === owner.prereqOf);
			if (current === undefined || e.p > current.p) owner.prereqOf = e.to;
		}

		// persist
		store.saveProposals(proposals);
		for (const p of targets) {
			const s = state.get(p.id)!;
			store.saveRank(p.id, s.decision, JSON.stringify(s.dims), stamp);
		}
		for (const [reason, ids] of aggregate) {
			reviews.push({ proposalId: null, reason, detail: `${ids.length} items without a usable judgment; first ids: ${ids.slice(0, 20).join(",")}` });
		}
		store.replaceReviews(reviews.map((r) => ({ ...r, id: deps.newId(), at: stamp })));

		const counts = (d: Decision) => targets.filter((p) => state.get(p.id)!.decision === d).length;
		out(`proposals: ${proposals.length} total, ${counts("propose")} propose, ${counts("review")} review, ${counts("skip")} skip, ${counts("none")} none; ${reviews.length} review rows`);
		return 0;
	} catch (error) {
		if (error instanceof NoTokenError) {
			out("scan stopped: no judge token is configured (set the profile's token variable, or use --judge configured-llm). Nothing further was written.");
			return 1;
		}
		throw error;
	}
}

/** The topic string a cluster key stands for, for the review row. */
function topicOf(topicList: readonly string[], key: string): string {
	return topicList[Number(key.slice(1))] ?? key;
}

// ---- list / label / propose / report ------------------------------------------------------------------------------

function list(deps: CliDeps): number {
	const { store, out } = deps;
	const ranks = new Map(store.ranks().map((r) => [r.proposalId, r]));
	const labels = new Map(store.labels().map((l) => [l.proposalId, l.verdict]));
	const items = new Map(store.items().map((i) => [i.id, i]));
	const shown = store.loadProposals().filter((p) => ranks.get(p.id)?.decision === "propose" || ranks.get(p.id)?.decision === "review");
	const ids = shown.map((p) => p.id);
	const edges = shown.flatMap((p) => (p.prereqOf === null ? [] : [{ from: p.id, to: p.prereqOf, p: 1 }]));
	const priority = new Map(shown.map((p) => [p.id, p.rankScore ?? Number.NEGATIVE_INFINITY]));
	const byId = new Map(shown.map((p) => [p.id, p]));
	const order = topoOrder(ids, edges, priority);
	if (order.length === 0) out("nothing to show: run `scan` first");
	order.forEach((id, n) => {
		const p = byId.get(id)!;
		const r = ranks.get(id)!;
		out(`${n + 1}. [${r.decision}] ${p.title}  (${p.status}, label: ${labels.get(id) ?? "none"}, rank: ${p.rankScore === null ? "none" : round2(p.rankScore)})`);
		out(`   id: ${id}`);
		out(`   why: ${p.why}`);
		for (const eid of p.evidenceIds.slice(0, 3)) {
			const item = items.get(eid);
			if (item) out(`   - ${clipSnippet(item.textRedacted).slice(0, 120).replace(/\s+/g, " ")}`);
		}
	});
	return 0;
}

function label(deps: CliDeps, id: string, verdict: Verdict): number {
	if (!deps.store.loadProposals().some((p) => p.id === id)) {
		deps.out(`no proposal with id ${id}`);
		return 1;
	}
	deps.store.setLabel(id, verdict, deps.now());
	deps.out(`labelled ${id}: ${verdict}`);
	return 0;
}

const ChatCreated = Type.Object({ id: Type.String({ minLength: 1 }) });

async function propose(deps: CliDeps): Promise<number> {
	const { store, out, allowEgress } = deps;
	const learn = new Set(store.labels().filter((l) => l.verdict === "learn").map((l) => l.proposalId));
	const accepted = new Set(store.accepts().map((a) => a.proposalId));
	const items = new Map(store.items().map((i) => [i.id, i]));
	const todo = store.loadProposals().filter((p) => learn.has(p.id) && p.status === "proposed" && !accepted.has(p.id));
	let failed = 0;
	let created = 0;
	for (const p of todo) {
		const evidence = p.evidenceIds.flatMap((id) => items.get(id) ?? []).filter((i) => allowEgress(i.project)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
		const first = evidence[0];
		if (!first) {
			out(`skipped ${p.id}: no evidence item is allowed to leave (egress opt-out), so nothing was posted`);
			continue;
		}
		const firstMessage = `I keep running into ${p.title} (for example: ${clipSnippet(first.textRedacted)}). Teach me it from first principles, then check my understanding.`;
		// shortcut: a crash between a good POST and the accept write makes a re-run create a second chat; add a client request id to POST /api/chats if that ever happens.
		let res: Response;
		try {
			res = await deps.fetch(`${deps.baseUrl}/api/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: p.title }) });
		} catch {
			out(`failed ${p.id}: could not reach ${deps.baseUrl}`);
			failed++;
			continue;
		}
		if (res.status === 401 || res.status === 403) {
			out(`refused (${res.status}). ${DESKTOP_NOTE}`);
			return 1;
		}
		let body: unknown = null;
		if (res.ok) body = await res.json().catch(() => null);
		if (!res.ok || !Value.Check(ChatCreated, body)) {
			out(`failed ${p.id}: server answered ${res.status}`);
			failed++;
			continue;
		}
		store.saveAccept({ proposalId: p.id, chatId: body.id, firstMessage, at: deps.now() });
		created++;
		out(`started chat ${body.id} for ${p.title}`);
	}
	out(`${created} chats started, ${failed} failed. The first message is stored for the Home panel; no message was sent. ${DESKTOP_NOTE}`);
	return failed > 0 ? 1 : 0;
}

function report(deps: CliDeps): number {
	const { store, out } = deps;
	const proposals = new Map(store.loadProposals().map((p) => [p.id, p]));
	const ranks = new Map(store.ranks().map((r) => [r.proposalId, r]));
	const labels = store.labels();
	const rows: LabelledRow[] = labels.map((l) => ({ id: l.proposalId, verdict: l.verdict, score: proposals.get(l.proposalId)?.rankScore ?? null }));
	out(`labels: ${labels.length}`);
	if (labels.length < 70) out(`Only ${labels.length} labels, under 70: treat this report as anecdote and do not refit thresholds or weights yet.`);
	for (const r of rows) {
		const dims = ranks.get(r.id)?.dimensionsJson ?? "not ranked";
		out(`${r.verdict.padEnd(5)} rank ${r.score === null ? "none" : round2(r.score)}  ${proposals.get(r.id)?.title ?? r.id}  ${dims}`);
	}
	const cal = calibration(rows);
	out("tau  threshold  predicted  precision  recall");
	const pct = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
	for (const s of cal.steps) out(`${s.tau.toFixed(1)}  ${round2(s.threshold)}  ${s.predicted}  ${pct(s.precision)}  ${pct(s.recall)}`);
	const title = (id: string) => proposals.get(id)?.title ?? id;
	out(`high rank but know/skip: ${cal.highRankNotLearn.map(title).join("; ") || "none"}`);
	out(`low rank but learn: ${cal.lowRankLearn.map(title).join("; ") || "none"}`);
	return 0;
}
