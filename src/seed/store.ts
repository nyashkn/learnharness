import type { JudgmentCache } from "./judge/port";
import type { Proposal } from "./proposals";
import { redact } from "./redact";
import type { HarvestItem } from "./types";

/** src/seed may not import src/store, so this is the structural slice of SqlDriver it needs. Synchronous: callers rely on transaction atomicity. */
export interface SeedDb {
	run(sql: string, ...params: (string | number | null)[]): { changes: number };
	all<T>(sql: string, ...params: (string | number | null)[]): T[];
	get<T>(sql: string, ...params: (string | number | null)[]): T | undefined;
	transaction<T>(fn: () => T): T;
}

export type Verdict = "learn" | "know" | "skip";
export type Decision = "propose" | "skip" | "ask_user" | "none" | "review";

export interface StoredRank {
	proposalId: string;
	decision: Decision;
	dimensionsJson: string;
	at: string;
}

export interface ReviewRow {
	id: string;
	proposalId: string | null;
	reason: string;
	detail: string;
	at: string;
}

export interface AcceptRow {
	proposalId: string;
	chatId: string;
	firstMessage: string;
	at: string;
}

interface ProposalRow {
	id: string;
	title: string;
	why: string;
	kind: Proposal["kind"];
	prereq_of: string | null;
	first_seen: string;
	last_seen: string;
	n_items: number;
	n_projects: number;
	rank_score: number | null;
	status: Proposal["status"];
	merged_into: string | null;
}

interface ItemRow {
	id: string;
	source: HarvestItem["source"];
	project: string | null;
	session_id: string | null;
	at: string;
	signal: HarvestItem["signal"];
	text_redacted: string;
}

/**
 * Scans upsert; nothing here deletes a proposal or touches `label`. Labels are the one thing that cannot be rebuilt.
 * Text goes through redact() again on the way in: it is idempotent, so a forged HarvestItem still cannot store a secret.
 */
export function createSeedStore(db: SeedDb) {
	return {
		upsertItems(items: readonly HarvestItem[]): void {
			db.transaction(() => {
				for (const item of items) {
					db.run(
						`INSERT INTO harvest_item (id, source, project, session_id, at, signal, text_redacted) VALUES (?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT(id) DO UPDATE SET source = excluded.source, project = excluded.project, session_id = excluded.session_id,
						   at = excluded.at, signal = excluded.signal, text_redacted = excluded.text_redacted`,
						item.id,
						item.source,
						item.project === null ? null : redact(item.project),
						item.sessionId === null ? null : redact(item.sessionId),
						item.at,
						item.signal,
						redact(item.textRedacted),
					);
				}
			});
		},

		items(): HarvestItem[] {
			return db.all<ItemRow>("SELECT id, source, project, session_id, at, signal, text_redacted FROM harvest_item ORDER BY at, id").map((r) => ({
				id: r.id,
				source: r.source,
				project: r.project,
				sessionId: r.session_id,
				at: r.at,
				signal: r.signal,
				textRedacted: r.text_redacted,
			}));
		},

		/** Only where no code signal fired: a confusion cue outranks a repeat. */
		markRepeats(ids: readonly string[]): void {
			db.transaction(() => {
				for (const id of ids) db.run("UPDATE harvest_item SET signal = 'repeat' WHERE id = ? AND signal IS NULL", id);
			});
		},

		loadProposals(): Proposal[] {
			const evidence = new Map<string, string[]>();
			for (const row of db.all<{ proposal_id: string; item_id: string }>("SELECT proposal_id, item_id FROM proposal_evidence ORDER BY item_id")) {
				const list = evidence.get(row.proposal_id) ?? [];
				list.push(row.item_id);
				evidence.set(row.proposal_id, list);
			}
			return db.all<ProposalRow>("SELECT * FROM proposal ORDER BY first_seen, id").map((r) => ({
				id: r.id,
				title: r.title,
				why: r.why,
				kind: r.kind,
				prereqOf: r.prereq_of,
				firstSeen: r.first_seen,
				lastSeen: r.last_seen,
				nItems: r.n_items,
				nProjects: r.n_projects,
				rankScore: r.rank_score,
				status: r.status,
				mergedInto: r.merged_into,
				evidenceIds: evidence.get(r.id) ?? [],
			}));
		},

		/** Upsert with evidence, one transaction. `status` is deliberately not updated: acceptance is recorded by saveAccept alone. */
		saveProposals(proposals: readonly Proposal[]): void {
			db.transaction(() => {
				for (const p of proposals) {
					db.run(
						`INSERT INTO proposal (id, title, why, kind, prereq_of, first_seen, last_seen, n_items, n_projects, rank_score, status, merged_into)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT(id) DO UPDATE SET title = excluded.title, why = excluded.why, kind = excluded.kind, prereq_of = excluded.prereq_of,
						   first_seen = excluded.first_seen, last_seen = excluded.last_seen, n_items = excluded.n_items, n_projects = excluded.n_projects,
						   rank_score = excluded.rank_score, merged_into = excluded.merged_into`,
						p.id,
						redact(p.title), // model-written, so it gets the same pass as harvested text
						redact(p.why),
						p.kind,
						p.prereqOf,
						p.firstSeen,
						p.lastSeen,
						p.nItems,
						p.nProjects,
						p.rankScore,
						p.status,
						p.mergedInto,
					);
					db.run("DELETE FROM proposal_evidence WHERE proposal_id = ?", p.id);
					for (const itemId of p.evidenceIds) db.run("INSERT INTO proposal_evidence (proposal_id, item_id) VALUES (?, ?)", p.id, itemId);
				}
			});
		},

		setLabel(proposalId: string, verdict: Verdict, at: string): void {
			db.run("INSERT INTO label (proposal_id, verdict, at) VALUES (?, ?, ?) ON CONFLICT(proposal_id) DO UPDATE SET verdict = excluded.verdict, at = excluded.at", proposalId, verdict, at);
		},

		labels(): { proposalId: string; verdict: Verdict; at: string }[] {
			return db.all<{ proposal_id: string; verdict: Verdict; at: string }>("SELECT proposal_id, verdict, at FROM label ORDER BY proposal_id").map((r) => ({ proposalId: r.proposal_id, verdict: r.verdict, at: r.at }));
		},

		/** The accept record, its "learn" label and the status flip commit together: an accept is always a label the calibration can read. */
		saveAccept(row: AcceptRow): void {
			db.transaction(() => {
				db.run("INSERT INTO proposal_accept (proposal_id, chat_id, first_message, at) VALUES (?, ?, ?, ?)", row.proposalId, row.chatId, row.firstMessage, row.at);
				// an existing learn label keeps its own time
				db.run(
					"INSERT INTO label (proposal_id, verdict, at) VALUES (?, 'learn', ?) ON CONFLICT(proposal_id) DO UPDATE SET verdict = 'learn', at = excluded.at WHERE label.verdict <> 'learn'",
					row.proposalId,
					row.at,
				);
				db.run("UPDATE proposal SET status = 'accepted' WHERE id = ?", row.proposalId);
			});
		},

		accepts(): AcceptRow[] {
			return db.all<{ proposal_id: string; chat_id: string; first_message: string; at: string }>("SELECT * FROM proposal_accept ORDER BY proposal_id").map((r) => ({ proposalId: r.proposal_id, chatId: r.chat_id, firstMessage: r.first_message, at: r.at }));
		},

		saveRank(proposalId: string, decision: Decision, dimensionsJson: string, at: string): void {
			db.run(
				"INSERT INTO proposal_rank (proposal_id, decision, dimensions_json, at) VALUES (?, ?, ?, ?) ON CONFLICT(proposal_id) DO UPDATE SET decision = excluded.decision, dimensions_json = excluded.dimensions_json, at = excluded.at",
				proposalId,
				decision,
				dimensionsJson,
				at,
			);
		},

		ranks(): StoredRank[] {
			return db.all<{ proposal_id: string; decision: Decision; dimensions_json: string; at: string }>("SELECT * FROM proposal_rank ORDER BY proposal_id").map((r) => ({ proposalId: r.proposal_id, decision: r.decision, dimensionsJson: r.dimensions_json, at: r.at }));
		},

		replaceReviews(rows: readonly ReviewRow[]): void {
			db.transaction(() => {
				db.run("DELETE FROM review_item");
				for (const r of rows) db.run("INSERT INTO review_item (id, proposal_id, reason, detail, at) VALUES (?, ?, ?, ?, ?)", r.id, r.proposalId, r.reason, redact(r.detail), r.at);
			});
		},

		reviews(): ReviewRow[] {
			return db.all<{ id: string; proposal_id: string | null; reason: string; detail: string; at: string }>("SELECT * FROM review_item ORDER BY at, id").map((r) => ({ id: r.id, proposalId: r.proposal_id, reason: r.reason, detail: r.detail, at: r.at }));
		},

		judgmentCache(): JudgmentCache {
			return {
				async get(requestSha) {
					const row = db.get<{ response_json: string }>("SELECT response_json FROM judgment_cache WHERE request_sha = ?", requestSha);
					return row ? { responseJson: row.response_json } : null;
				},
				async put(requestSha, model, responseJson, at) {
					db.run("INSERT OR REPLACE INTO judgment_cache (request_sha, model, response_json, at) VALUES (?, ?, ?, ?)", requestSha, model, responseJson, at);
				},
			};
		},
	};
}

export type SeedStore = ReturnType<typeof createSeedStore>;
