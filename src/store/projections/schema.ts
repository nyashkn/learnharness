/** projections.sqlite DDL, copied from docs/architecture/schema/projections.sql (bundlers cannot read .sql at runtime). Keep in sync. */
export const PROJECTION_DDL = `
-- projections.sqlite: DERIVED, plain SQLite (stock node:sqlite, never DoltLite: FTS5 in DoltLite was 3.9x larger in datalib).
-- Never migrated (R7). On projection_hash mismatch: drop everything and rebuild from getGraph().
-- projection_hash = sha256(this DDL + LOGIC_VERSION + hash of fold source). Bump LOGIC_VERSION when fold logic changes without DDL changes;
-- the fold-source hash rebuilds even if the bump is forgotten.

CREATE TABLE proj_meta (
  key   TEXT PRIMARY KEY,          -- projection_hash, built_at
  value TEXT NOT NULL
);

-- Written in the SAME transaction as the rows below (datalib render_cursor pattern).
-- If lh_meta.store_id != store_id or GraphStore.revision() != source_revision, rebuild.
CREATE TABLE proj_cursor (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  store_id        TEXT NOT NULL,
  source_revision TEXT NOT NULL
);

CREATE TABLE node (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  statement  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE node_alias (
  node_id TEXT NOT NULL,
  alias   TEXT NOT NULL,
  PRIMARY KEY (node_id, alias)
) WITHOUT ROWID;

CREATE TABLE node_provenance (
  node_id    TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (node_id, chat_id, message_id)
) WITHOUT ROWID;

CREATE TABLE chain (
  id            TEXT PRIMARY KEY,
  conclusion_id TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX chain_by_conclusion ON chain (conclusion_id);

CREATE TABLE chain_premise (
  chain_id   TEXT NOT NULL,
  premise_id TEXT NOT NULL,
  PRIMARY KEY (chain_id, premise_id)
) WITHOUT ROWID;
CREATE INDEX chain_premise_by_premise ON chain_premise (premise_id);

-- Candidate search for the auditor (replaces lexical top-5 behind a flag, PR7/J2).
CREATE VIRTUAL TABLE node_fts USING fts5(
  node_id UNINDEXED,
  name,
  statement,
  aliases,
  tokenize = 'unicode61'
);

-- "Everything needed to derive :target". The row is the id alone, so UNION dedupes ids and
-- the recursion terminates on cycles (checked with sqlite3 on a 2-cycle, 2026-11-08).
-- Do not add a depth column to the row: (id, depth) rows never repeat and only a depth cap would stop it.
-- WITH RECURSIVE need(id) AS (
--   SELECT :target
--   UNION
--   SELECT cp.premise_id
--   FROM need JOIN chain c ON c.conclusion_id = need.id
--             JOIN chain_premise cp ON cp.chain_id = c.id)
-- SELECT id FROM need;
`;
