import type { Rung } from "../../rung";

/** Copy of docs/architecture/schema/seeds/0001_init.sql. Immutable once released (R6). */
export default {
	version: 1,
	name: "init",
	up: (db) =>
		db.exec(`
-- seeds.sqlite, rung 1. Plain SQLite, private, local only. Owned by src/seed (CB7).
-- harvest_item/proposal/proposal_evidence/judgment_cache are rebuildable; label is NOT (it is the owner's ground truth), so this store migrates.

CREATE TABLE lh_meta (
  key   TEXT PRIMARY KEY,          -- store_kind='seeds', schema_version, lh_version
  value TEXT NOT NULL
);

-- One redacted human prompt, recap or summary. Text is redacted BEFORE insert.
CREATE TABLE harvest_item (
  id            TEXT PRIMARY KEY,  -- sha256(source || native id)
  source        TEXT NOT NULL CHECK (source IN ('claude-history','claude-session','omp-history','omp-recap','omp-memory','signet-summary')),
  project       TEXT,              -- cwd slug
  session_id    TEXT,
  at            TEXT NOT NULL,     -- ISO-8601 UTC
  signal        TEXT,              -- confusion | repeat | decision | delegated | null
  text_redacted TEXT NOT NULL
);
CREATE INDEX harvest_item_by_project ON harvest_item (project, at);

-- A proposed teaching session. id is stable across rescans (assigned once; later runs align to it by the 3-level score, not by label hash).
CREATE TABLE proposal (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  why         TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('concept','skill','tool','pattern')),
  prereq_of   TEXT NULL,           -- proposal id this one is a prerequisite of (prerequisite order, built in code)
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  n_items     INTEGER NOT NULL,
  n_projects  INTEGER NOT NULL,
  rank_score  REAL,                -- computed in code from judgments + counts (policy in code)
  status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','dismissed','merged')),
  merged_into TEXT NULL            -- set when status = 'merged'
);

CREATE TABLE proposal_evidence (
  proposal_id TEXT NOT NULL REFERENCES proposal (id),
  item_id     TEXT NOT NULL REFERENCES harvest_item (id),
  PRIMARY KEY (proposal_id, item_id)
) WITHOUT ROWID;

-- Every decision-model call cached by request hash (Clef/Jev guide section 5).
CREATE TABLE judgment_cache (
  request_sha   TEXT PRIMARY KEY,
  model         TEXT NOT NULL,     -- '@cf/cloudflare/clef' | 'typesafe/jev-1.14.0' | 'configured-llm'
  response_json TEXT NOT NULL,
  at            TEXT NOT NULL
);

-- Owner ground truth; used to calibrate thresholds (about 70 labels before thresholds are fixed). Survives re-runs.
CREATE TABLE label (
  proposal_id TEXT PRIMARY KEY,
  verdict     TEXT NOT NULL CHECK (verdict IN ('learn','know','skip')),
  at          TEXT NOT NULL
);
`),
} satisfies Rung;
