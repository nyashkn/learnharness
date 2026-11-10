import type { Rung } from "../../rung";

/** Copy of docs/architecture/schema/blobs/0001_init.sql. Immutable once released (R6). */
export default {
	version: 1,
	name: "init",
	up: (db) =>
		db.exec(`
-- blobs.sqlite, rung 1. Plain SQLite, append-only, never versioned (D7). LATER LANE: not on the DoltLite path.
-- Open with PRAGMA synchronous=FULL. Write bytes BEFORE the row that references them; an orphan is harmless.
-- The store hashes the bytes itself (callers never supply the key). INSERT OR IGNORE makes duplicates a no-op.
-- First consumer: ChatRecord.imageSnapshots (already SHA-256 keyed, chats.ts:142).

CREATE TABLE lh_meta (
  key   TEXT PRIMARY KEY,          -- store_kind='blobs', schema_version, lh_version
  value TEXT NOT NULL
);

CREATE TABLE cas_objects (
  hash         TEXT PRIMARY KEY CHECK (length(hash) = 64),  -- sha256 hex of bytes
  byte_len     INTEGER NOT NULL,
  content_type TEXT NOT NULL,                                -- sniffed from leading bytes, not the file name
  bytes        BLOB NOT NULL
);
`),
} satisfies Rung;
