import { Type } from "typebox";
import type { ReadOnlyDb, ReadOnlyFiles, SessionSource } from "../types";
import { epochToIso, nullable, validRows } from "./shared";

const History = Type.Object({
	id: Type.Integer(),
	prompt: Type.String(),
	created_at: Type.Number(),
	cwd: nullable(Type.String()),
	session_id: nullable(Type.String()),
});

export function ompHistorySource(db: ReadOnlyDb): SessionSource {
	const stats = { skipped: 0 };
	return {
		name: "omp-history",
		stats,
		async *items() {
			stats.skipped = 0;
			const rows = await db.all("SELECT id, prompt, created_at, cwd, session_id FROM history ORDER BY id");
			for (const row of validRows(rows, History, stats)) {
				const at = epochToIso(row.created_at, "s");
				if (at === null) {
					stats.skipped++;
					continue;
				}
				if (row.prompt.trim() === "") continue;
				yield { source: "omp-history", nativeId: `history:${row.id}`, project: row.cwd, sessionId: row.session_id, at, text: row.prompt };
			}
		},
	};
}

const Recap = Type.Object({
	id: Type.Integer(),
	session_id: Type.String(),
	cwd: nullable(Type.String()),
	recap: Type.String(),
	created_at: Type.Number(),
});

export function ompRecapSource(db: ReadOnlyDb): SessionSource {
	const stats = { skipped: 0 };
	return {
		name: "omp-recap",
		stats,
		async *items() {
			stats.skipped = 0;
			const rows = await db.all("SELECT id, session_id, cwd, recap, created_at FROM session_recaps ORDER BY id");
			for (const row of validRows(rows, Recap, stats)) {
				const at = epochToIso(row.created_at, "s");
				if (at === null) {
					stats.skipped++;
					continue;
				}
				if (row.recap.trim() === "") continue;
				yield { source: "omp-recap", nativeId: `recap:${row.id}`, project: row.cwd, sessionId: row.session_id, at, text: row.recap };
			}
		},
	};
}

// rollout_summary only: raw_memory is never selected.
const Stage1 = Type.Object({
	thread_id: Type.String(),
	generated_at: Type.Number(),
	rollout_summary: Type.String(),
	cwd: nullable(Type.String()),
});

export function ompMemorySource(io: { agentDb: ReadOnlyDb; files: ReadOnlyFiles; memoriesDir: string }): SessionSource {
	const stats = { skipped: 0 };
	return {
		name: "omp-memory",
		stats,
		async *items() {
			stats.skipped = 0;
			const rows = await io.agentDb.all(
				"SELECT s.thread_id AS thread_id, s.generated_at AS generated_at, s.rollout_summary AS rollout_summary, t.cwd AS cwd " +
					"FROM stage1_outputs s JOIN threads t ON s.thread_id = t.id ORDER BY s.generated_at",
			);
			for (const row of validRows(rows, Stage1, stats)) {
				const at = epochToIso(row.generated_at, "auto");
				if (at === null) {
					stats.skipped++;
					continue;
				}
				if (row.rollout_summary.trim() === "") continue;
				yield { source: "omp-memory", nativeId: `stage1:${row.thread_id}`, project: row.cwd, sessionId: row.thread_id, at, text: row.rollout_summary };
			}
			for (const slug of await io.files.list(io.memoriesDir)) {
				const path = `${io.memoriesDir}/${slug}/learned.md`;
				let text: string;
				let mtime: Date;
				try {
					text = await io.files.read(path);
					mtime = await io.files.mtime(path);
				} catch {
					continue; // most slug folders have no learned.md; not a malformed row
				}
				if (Number.isNaN(mtime.getTime()) || text.trim() === "") continue;
				const at = mtime.toISOString();
				yield { source: "omp-memory", nativeId: `${slug}/learned.md`, project: slug, sessionId: null, at, text };
			}
		},
	};
}
