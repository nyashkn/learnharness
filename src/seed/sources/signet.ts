import { Type } from "typebox";
import type { ReadOnlyDb, SessionSource } from "../types";
import { isoOrNull, nullable, validRows } from "./shared";

const Summary = Type.Object({
	id: Type.String(),
	project: nullable(Type.String()),
	// 0 is a session; arc and epoch rollups sit above it (Signet migration 029)
	depth: Type.Integer(),
	content: Type.String(),
	latest_at: Type.String(),
	session_key: nullable(Type.String()),
});

const Entity = Type.Object({
	id: Type.String(),
	name: Type.String(),
	description: nullable(Type.String()),
	updated_at: Type.String(),
	mentions: Type.Number(),
});

/** minMentions has no default: the composition root decides how popular an entity must be. */
export function signetSummarySource(io: { db: ReadOnlyDb; minMentions: number }): SessionSource {
	const stats = { skipped: 0 };
	return {
		name: "signet-summary",
		stats,
		async *items() {
			stats.skipped = 0;
			const summaries = await io.db.all("SELECT id, project, depth, content, latest_at, session_key FROM session_summaries ORDER BY latest_at");
			for (const row of validRows(summaries, Summary, stats)) {
				const at = isoOrNull(row.latest_at);
				if (at === null) {
					stats.skipped++;
					continue;
				}
				if (row.content.trim() === "") continue;
				// latest_at is a session's own last time; an arc or epoch rollup spans many sessions, so it has none and --since leaves it out
				const sessionAt = row.depth === 0 ? at : null;
				yield { source: "signet-summary", nativeId: `summary:${row.id}`, project: row.project, sessionId: row.session_key, at, sessionAt, text: row.content };
			}
			const entities = await io.db.all(
				"SELECT id, name, description, updated_at, mentions FROM entities WHERE mentions >= ? ORDER BY updated_at",
				[io.minMentions],
			);
			for (const row of validRows(entities, Entity, stats)) {
				const at = isoOrNull(row.updated_at);
				if (at === null) {
					stats.skipped++;
					continue;
				}
				const text = row.description ? `${row.name}\n${row.description}` : row.name;
				if (text.trim() === "") continue;
				// an entity accumulates across all sessions: no session time
				yield { source: "signet-summary", nativeId: `entity:${row.id}`, project: null, sessionId: null, at, sessionAt: null, text };
			}
		},
	};
}
