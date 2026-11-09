import type { Rung } from "../../rung";

/** Adds what rung 1 lacks: the accept record K5 prefills from, the rank decision, and the review queue. */
export default {
	version: 2,
	name: "accept_rank_review",
	up: (db) =>
		db.exec(`
CREATE TABLE proposal_accept (
  proposal_id   TEXT PRIMARY KEY REFERENCES proposal (id),
  chat_id       TEXT NOT NULL,
  first_message TEXT NOT NULL,
  at            TEXT NOT NULL
);

CREATE TABLE proposal_rank (
  proposal_id     TEXT PRIMARY KEY REFERENCES proposal (id),
  decision        TEXT NOT NULL CHECK (decision IN ('propose','skip','ask_user','none','review')),
  dimensions_json TEXT NOT NULL,
  at              TEXT NOT NULL
);

CREATE TABLE review_item (
  id          TEXT PRIMARY KEY,
  proposal_id TEXT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT NOT NULL,
  at          TEXT NOT NULL
);
`),
} satisfies Rung;
