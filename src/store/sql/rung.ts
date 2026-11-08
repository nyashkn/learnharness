import type { SqlDriver } from "./driver";

/** One migration step (architecture 5.3). Additive only; the runner owns the lh_meta bump and the transaction. */
export interface Rung {
	/** Dense, from 1 per store kind. */
	version: number;
	name: string;
	/** Runs inside the runner's transaction. Rung 1 must create `lh_meta`. */
	up(db: SqlDriver): void;
}
