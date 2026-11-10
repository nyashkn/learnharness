/**
 * projections.sqlite builder (bead lh-iz9, arch 4.3): DERIVED from the GraphStore, never migrated.
 * Every rebuild is ONE BEGIN IMMEDIATE transaction (rows + proj_cursor + proj_meta together).
 * No store lock: concurrent rebuilders take turns on the write lock.
 */
import { createHash } from "node:crypto";
import { getGraph, type DerivedGraph } from "../../core/graph.ts";
import type { GraphStore, ProjectionStore } from "../../core/ports.ts";
import type { SqlDriver } from "../sql/driver";
import { openNodeSqlite } from "../sql/drivers/node-sqlite";
import { PROJECTION_DDL } from "./schema";

/** Bump when the fold changes without a DDL change (the fold-source hash is the safety net). */
export const LOGIC_VERSION = 1;
const BUSY_TIMEOUT_MS = 10_000;

/** The pure rows of one graph, no I/O. */
export function foldRows(graph: DerivedGraph) {
	const uniq = <T>(xs: T[]) => [...new Set(xs)];
	return {
		nodes: graph.nodes.map((n) => ({
			id: n.id, name: n.name, statement: n.statement, createdAt: n.createdAt,
			aliases: uniq(n.aliases),
			provenance: uniq(n.provenance.map((p) => JSON.stringify([p.chatId, p.messageId]))).map((j) => JSON.parse(j) as [string, string]),
		})),
		chains: graph.chains.map((c) => ({ id: c.id, conclusion: c.conclusion, createdAt: c.createdAt, premises: uniq(c.premises) })),
	};
}

export function projectionHash(ddl: string, logicVersion: number, foldSource: string): string {
	return createHash("sha256").update(ddl).update("\0").update(String(logicVersion)).update("\0").update(foldSource).digest("hex");
}

export const CURRENT_PROJECTION_HASH = projectionHash(PROJECTION_DDL, LOGIC_VERSION, foldRows.toString() + "\0" + getGraph.toString());

const CLOSURE_SQL = `WITH RECURSIVE need(id) AS (
  SELECT ?
  UNION
  SELECT cp.premise_id
  FROM need JOIN chain c ON c.conclusion_id = need.id
            JOIN chain_premise cp ON cp.chain_id = c.id)
SELECT id FROM need ORDER BY id`;

/** Words are runs of letters, numbers and marks (what FTS5 unicode61 tokenizes); each is quoted, so no text is FTS syntax. */
function ftsQuery(query: string): string | null {
	const words = query.split(/[^\p{L}\p{N}\p{M}\p{Co}]+/u).filter(Boolean);
	return words.length === 0 ? null : words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" OR ");
}

/** `PRAGMA journal_mode = WAL` on a fresh file ignores busy_timeout: two openers at once get "database is locked". Retry that open. */
function openWithRetry(file: string): SqlDriver {
	for (let attempt = 0; ; attempt++) {
		try {
			return openNodeSqlite(file, { busyTimeoutMs: BUSY_TIMEOUT_MS });
		} catch (error) {
			if (attempt >= 100 || !/database is locked/.test(String(error))) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
}

export interface OpenProjectionOptions {
	file: string;
	storeId: string;
	graph: Pick<GraphStore, "readNodes" | "readChains" | "revision">;
	/** TEST-ONLY: wrap the driver (fault injection). */
	wrapDriver?: (driver: SqlDriver) => SqlDriver;
}

export function openProjectionStore(options: OpenProjectionOptions): ProjectionStore & { close(): void } {
	const { storeId, graph } = options;
	const raw = openWithRetry(options.file);
	const driver = options.wrapDriver ? options.wrapDriver(raw) : raw;

	function rebuild(): void {
		// Revision BEFORE the fold: a write landing in between leaves the cursor stale-low, so the next read rebuilds again.
		const revision = String(graph.revision());
		const rows = foldRows(getGraph(graph));
		driver.transaction(() => {
			let stored: string | undefined;
			try {
				stored = driver.get<{ value: string }>("SELECT value FROM proj_meta WHERE key = 'projection_hash'")?.value;
			} catch {
				stored = undefined; // no table, or a junk one
			}
			if (stored !== CURRENT_PROJECTION_HASH) {
				for (const kind of ["VIRTUAL", "TABLE"]) {
					const sql = kind === "VIRTUAL" ? "sql LIKE 'CREATE VIRTUAL%'" : "sql NOT LIKE 'CREATE VIRTUAL%'";
					for (const t of driver.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND ${sql}`)) {
						driver.exec(`DROP TABLE IF EXISTS "${t.name.replaceAll('"', '""')}"`);
					}
				}
				driver.exec(PROJECTION_DDL);
			}
			for (const t of ["node", "node_alias", "node_provenance", "chain", "chain_premise", "node_fts"]) driver.run(`DELETE FROM ${t}`);
			for (const n of rows.nodes) {
				driver.run("INSERT OR IGNORE INTO node (id, name, statement, created_at) VALUES (?, ?, ?, ?)", n.id, n.name, n.statement, n.createdAt);
				for (const a of n.aliases) driver.run("INSERT OR IGNORE INTO node_alias (node_id, alias) VALUES (?, ?)", n.id, a);
				for (const [chat, message] of n.provenance) driver.run("INSERT OR IGNORE INTO node_provenance (node_id, chat_id, message_id) VALUES (?, ?, ?)", n.id, chat, message);
				driver.run("INSERT INTO node_fts (node_id, name, statement, aliases) VALUES (?, ?, ?, ?)", n.id, n.name, n.statement, n.aliases.join("\n"));
			}
			for (const c of rows.chains) {
				driver.run("INSERT OR IGNORE INTO chain (id, conclusion_id, created_at) VALUES (?, ?, ?)", c.id, c.conclusion, c.createdAt);
				for (const p of c.premises) driver.run("INSERT OR IGNORE INTO chain_premise (chain_id, premise_id) VALUES (?, ?)", c.id, p);
			}
			driver.run("INSERT OR REPLACE INTO proj_cursor (id, store_id, source_revision) VALUES (1, ?, ?)", storeId, revision);
			driver.run("INSERT OR REPLACE INTO proj_meta (key, value) VALUES ('projection_hash', ?)", CURRENT_PROJECTION_HASH);
			driver.run("INSERT OR REPLACE INTO proj_meta (key, value) VALUES ('built_at', ?)", new Date().toISOString());
		});
	}

	function sync(): void {
		let cursor: { store_id: string; source_revision: string } | undefined;
		try {
			cursor = driver.get("SELECT store_id, source_revision FROM proj_cursor WHERE id = 1");
		} catch {
			cursor = undefined;
		}
		if (!cursor || cursor.store_id !== storeId || cursor.source_revision !== String(graph.revision())) rebuild();
	}

	rebuild(); // arch 4.3: rebuild at process start

	return {
		deriveClosure(targetId) {
			sync();
			return driver.all<{ id: string }>(CLOSURE_SQL, targetId).map((r) => r.id);
		},
		search(query, limit) {
			const match = ftsQuery(query);
			if (match === null || !(limit >= 1)) return [];
			sync();
			return driver.all<{ node_id: string }>("SELECT node_id FROM node_fts WHERE node_fts MATCH ? ORDER BY bm25(node_fts), node_id LIMIT ?", match, Math.floor(limit)).map((r) => r.node_id);
		},
		close: () => driver.close(),
	} satisfies ProjectionStore & { close(): void };
}
