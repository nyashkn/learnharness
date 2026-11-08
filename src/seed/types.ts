import type { Static, TSchema } from "typebox";

/** The single egress decision (K-D6): every outbound call passes through one of these. */
export type AllowEgress = (project: string | null) => boolean;

/** Narrow LLM port. scripts/seed.ts builds it from the user's provider settings; src/seed never sees those. */
export interface LlmPort {
	complete<S extends TSchema>(prompt: string, schema: S): Promise<Static<S>>;
}

export type HarvestSource = "claude-history" | "claude-session" | "omp-history" | "omp-recap" | "omp-memory" | "signet-summary";

export type Signal = "confusion" | "repeat" | "decision" | "delegated" | null;

/** What an adapter emits: unredacted, so it never leaves src/seed/sources except through harvest(). */
export interface RawItem {
	source: HarvestSource;
	nativeId: string;
	project: string | null;
	sessionId: string | null;
	/** ISO-8601 UTC. */
	at: string;
	text: string;
}

export interface HarvestItem {
	/** sha256(source || nativeId) */
	id: string;
	source: HarvestSource;
	project: string | null;
	sessionId: string | null;
	at: string;
	signal: Signal;
	textRedacted: string;
}

export interface ReadOnlyDb {
	all(sql: string, params?: readonly (string | number | null)[]): Promise<Record<string, unknown>[]>;
}

export interface ReadOnlyFiles {
	lines(path: string): AsyncIterable<string>;
	read(path: string): Promise<string>;
	/** Child names, not full paths. */
	list(dir: string): Promise<string[]>;
	mtime(path: string): Promise<Date>;
}

export interface SourceStats {
	/** Rows or lines that failed validation in the last items() run. Counted, never logged. */
	skipped: number;
}

export interface SessionSource {
	name: string;
	stats: SourceStats;
	items(): AsyncIterable<RawItem>;
}
