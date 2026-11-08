import type { Rung } from "../../rung";

/** Copy of docs/architecture/schema/graph/0001_init.sql. Immutable once released (R6). */
export default {
	version: 1,
	name: "init",
	up: (db) =>
		db.exec(`
-- Graph store, rung 1. Same DDL for node:sqlite (graph.sqlite) and DoltLite (graph.doltlite).
-- Immutable once released (R6). Applied in one transaction with the lh_meta bump (R4).
-- Ledger lines are stored verbatim (D2); folding stays in src/core/graph.ts.
-- seq is a rowid alias: append order is semantic (the first line for an id defines it).

CREATE TABLE lh_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys: store_kind='graph', schema_version, schema_hash, lh_version, engine, engine_version, revision,
--       line_format (= CURRENT_GRAPH_FORMAT_VERSION; R3 refuses newer), store_id (random UUID at creation)

CREATE TABLE ledger_nodes (
  seq       INTEGER PRIMARY KEY,
  line_json TEXT NOT NULL
);

CREATE TABLE ledger_chains (
  seq       INTEGER PRIMARY KEY,
  line_json TEXT NOT NULL
);

CREATE TABLE ledger_coverage (
  seq       INTEGER PRIMARY KEY,
  line_json TEXT NOT NULL
);

-- sessions.jsonl in the file backend ("checkpoints" in the GraphStore port)
CREATE TABLE ledger_checkpoints (
  seq       INTEGER PRIMARY KEY,
  line_json TEXT NOT NULL
);

-- sources.json map: one row per source record {id, filePath, importedAt, contentFp?, extractions?[]}
CREATE TABLE sources (
  id          TEXT PRIMARY KEY,
  record_json TEXT NOT NULL
);

-- small JSON documents of the graph family; key 'source-organization'
CREATE TABLE documents (
  key  TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
`),
} satisfies Rung;
