/** Times the due-queue read (readReviews + queue fold) at 10k propositions x 3 reviews each, on the file and sqlite backends.
 *  Prints ms per backend; no assertion. Stores are built through factories, in a temp folder. Run: `just bench-review`. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphNode } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { FACTORY_SETTINGS } from "../src/core/settings.ts";
import { reviewSummary } from "../src/server/review.ts";
import { createGraphStore } from "../src/store/graph.ts";
import { openNodeSqlite } from "../src/store/sql/drivers/node-sqlite.ts";
import { openGraphStore } from "../src/store/sql/graph-store.ts";

const PROPOSITIONS = 10_000;
const REVIEWS_EACH = 3;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-bench-review-"));

function fill(graph: GraphStore): void {
	graph.transact("bench fill", () => {
		for (let i = 0; i < PROPOSITIONS; i++) {
			const id = `n_${i}`;
			const n: GraphNode = { id, name: `n ${i}`, statement: `statement ${i}`, aliases: [], createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), provenance: [] };
			graph.appendNode(n);
			for (let r = 0; r < REVIEWS_EACH; r++) {
				const day = 1 + r * 3 + (i % 3);
				graph.appendReview({ id: `c${i}:p${r}`, chatId: `c${i}`, problemCallId: `p${r}`, at: new Date(Date.UTC(2026, 1, day, 12)).toISOString(), targets: [id], outcome: r === 2 && i % 5 === 0 ? "surrendered" : "solved", rung: null });
			}
		}
	});
}

function time(label: string, graph: GraphStore): void {
	const now = new Date(Date.UTC(2026, 2, 1, 12));
	const reads = [0, 0, 0].map(() => { const t = performance.now(); graph.readReviews(); return performance.now() - t; });
	const runs = [0, 0, 0].map(() => { const t = performance.now(); reviewSummary(now, graph, FACTORY_SETTINGS.review); return performance.now() - t; });
	const s = reviewSummary(now, graph, FACTORY_SETTINGS.review);
	console.log(`${label}: readReviews ${Math.min(...reads).toFixed(1)} ms; due-queue read (readReviews + graph + queue fold) ${Math.min(...runs).toFixed(1)} ms best of 3 (due ${s.dueCount}, picks ${s.picks.length}, ${PROPOSITIONS * REVIEWS_EACH} lines)`);
}

try {
	const fileDir = path.join(root, "file");
	fs.mkdirSync(fileDir, { recursive: true });
	const file = createGraphStore(fileDir);
	fill(file);
	time("file  ", file);

	const raw = openNodeSqlite(path.join(root, "graph.sqlite"));
	let positions = {};
	const sql = openGraphStore({ db: raw, file: "graph.sqlite", lhVersion: "bench", positions: { read: () => positions, write: (p) => { positions = p; } }, log: () => {} });
	fill(sql.store);
	time("sqlite", sql.store);
	raw.close();
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
