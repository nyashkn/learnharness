import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ReadOnlyFiles, SessionSource } from "../types";
import { epochToIso, sha256 } from "./shared";

// pastedContents is deliberately absent: it is never read.
const Line = Type.Object({
	display: Type.String(),
	timestamp: Type.Number(),
	project: Type.String(),
	sessionId: Type.String(),
});

export function claudeHistorySource(io: { files: ReadOnlyFiles; path: string }): SessionSource {
	const stats = { skipped: 0 };
	return {
		name: "claude-history",
		stats,
		async *items() {
			stats.skipped = 0;
			for await (const line of io.files.lines(io.path)) {
				if (line.trim() === "") continue;
				let row: unknown;
				try {
					row = JSON.parse(line);
				} catch {
					stats.skipped++;
					continue;
				}
				if (!Value.Check(Line, row)) {
					stats.skipped++;
					continue;
				}
				const at = epochToIso(row.timestamp, "ms");
				if (at === null) {
					stats.skipped++;
					continue;
				}
				if (row.display.trim() === "") continue;
				yield {
					source: "claude-history",
					// The file has no row id; the hash keeps the key stable without embedding the prompt.
					nativeId: `${row.timestamp}:${row.sessionId}:${sha256(row.display).slice(0, 16)}`,
					project: row.project,
					sessionId: row.sessionId,
					at,
					text: row.display,
				};
			}
		},
	};
}
