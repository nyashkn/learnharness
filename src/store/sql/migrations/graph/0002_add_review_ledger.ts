import type { Rung } from "../../rung";

/** The review ledger (R2): one row per concluded practice problem, stored verbatim, plus its append-only node-merge remaps. Additive only. */
export default {
	version: 2,
	name: "add_review_ledger",
	up: (db) =>
		db.exec(`
CREATE TABLE ledger_reviews (
  seq       INTEGER PRIMARY KEY,
  line_json TEXT NOT NULL
);

-- append-only {from,to}: reviews of a merged node follow it to the current id; resolved on read, review rows never rewritten
CREATE TABLE ledger_review_remaps (
  seq       INTEGER PRIMARY KEY,
  line_json TEXT NOT NULL
);
`),
} satisfies Rung;
