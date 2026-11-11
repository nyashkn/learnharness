/** Throwaway data folders, filled through the repo's factories (never singletons, never real data). */
import fs from "node:fs";
import path from "node:path";
import { runStoreScript } from "../../src/store/file-stores.ts";
import { createSeedStore } from "../../src/seed/store.ts";
import type { Proposal } from "../../src/seed/proposals.ts";
import { openNodeSqlite } from "../../src/store/sql/drivers/node-sqlite.ts";
import { migrate } from "../../src/store/sql/migrate.ts";
import { seedMigration } from "../../src/store/sql/migrations/seeds/index.ts";
import type { GraphNode } from "../../src/core/index.ts";

export const NODES = [
	{ id: "n_alpha", name: "Alpha rule", statement: "Alpha holds whenever beta does." },
	{ id: "n_beta", name: "Beta rule", statement: "Beta follows from gamma." },
	{ id: "n_gamma", name: "Gamma rule", statement: "Gamma is the base case." },
] as const;
const DAY = 86_400_000;
const node = (n: (typeof NODES)[number], source: string): GraphNode => ({ ...n, aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [{ chatId: source, messageId: "m1" }] });

/** Three propositions from one imported source; alpha and beta were practiced ten days ago (due), gamma never (new). `storage` only counts on an EMPTY folder. */
export async function seedGraph(dataDir: string, authFile: string, opts: { storage?: "sqlite" | "doltlite"; chat?: boolean } = {}): Promise<void> {
	const before = process.env.LH_STORAGE;
	if (opts.storage) process.env.LH_STORAGE = opts.storage; else delete process.env.LH_STORAGE;
	try {
		await runStoreScript(dataDir, authFile, (stores) => {
			if (process.exitCode) throw new Error("seed refused");
			stores.graphStore.transact("acceptance seed", () => {
				stores.graphStore.upsertSource({ id: "src_notes", filePath: "notes.md", importedAt: "2026-10-01T00:00:00.000Z" });
				for (const n of NODES) stores.graphStore.appendNode(node(n, "src_notes"));
				for (const n of NODES.slice(0, 2)) {
					stores.graphStore.appendReview({ id: `seed:${n.id}`, chatId: "seed", problemCallId: n.id, at: new Date(Date.now() - 10 * DAY).toISOString(), targets: [n.id], outcome: "solved", rung: null });
				}
			});
			if (opts.chat) {
				const chat = stores.chatStore.createChat("Kept session");
				stores.chatStore.saveMessages(chat.id, [{ id: "m", role: "assistant", content: [{ type: "text", text: "Synthetic teaching prose." }], timestamp: 1 } as never]);
			}
		});
	} finally {
		if (before === undefined) delete process.env.LH_STORAGE; else process.env.LH_STORAGE = before;
	}
}

const T = "2026-11-01T00:00:00.000Z";
const prop = (id: string, title: string): Proposal => ({ id, title, why: "your history keeps circling it", kind: "concept", prereqOf: null, firstSeen: T, lastSeen: T, nItems: 1, nProjects: 1, rankScore: 0.5, status: "proposed", mergedInto: null, evidenceIds: [`e-${id}`]});

/** seeds.sqlite beside the data folder's files, with two proposed sessions (what the home panel reads). */
export function seedProposals(dataDir: string): void {
	fs.mkdirSync(dataDir, { recursive: true });
	const db = openNodeSqlite(path.join(dataDir, "seeds.sqlite"));
	try {
		migrate(db, { ...seedMigration, lhVersion: "acceptance" });
		const store = createSeedStore(db);
		const ps = [prop("p_first", "Seed topic one"), prop("p_second", "Seed topic two")];
		store.upsertItems(ps.map((p) => ({ id: `e-${p.id}`, source: "claude-history", project: "/work/app", sessionId: `s-${p.id}`, at: T, signal: null, textRedacted: `question about ${p.title}` }) as never));
		store.saveProposals(ps);
		for (const p of ps) store.saveRank(p.id, "propose", "{}", T);
	} finally { db.close(); }
}

/** Read what the panel wrote (labels and accepts), straight from the file. */
export function readSeedDecisions(dataDir: string): { labels: Record<string, string>; accepts: string[] } {
	const db = openNodeSqlite(path.join(dataDir, "seeds.sqlite"));
	try {
		const store = createSeedStore(db);
		return { labels: Object.fromEntries(store.labels().map((l) => [l.proposalId, l.verdict])), accepts: store.accepts().map((a) => a.proposalId) };
	} finally { db.close(); }
}
