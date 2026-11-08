/**
 * SqlDriver (CB3): the only shape the SQL adapter knows about an engine.
 * Synchronous on purpose: callers rely on "no awaits, so atomic".
 * Implementations: drivers/node-sqlite.ts (S1); the DoltLite one lands in D1.
 */

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface SqlDriver {
	readonly engine: "sqlite" | "doltlite";
	readonly engineVersion: string;
	/** Run one or more statements, no parameters, no result. */
	exec(sql: string): void;
	/** Run one statement. `changes` is the number of rows it inserted, updated or deleted. */
	run(sql: string, ...params: SqlValue[]): { changes: number };
	all<T>(sql: string, ...params: SqlValue[]): T[];
	get<T>(sql: string, ...params: SqlValue[]): T | undefined;
	/**
	 * BEGIN IMMEDIATE ... COMMIT, ROLLBACK when `fn` throws.
	 * Nested calls join the outer transaction. A nested throw dooms the outer one:
	 * even if the caller catches it, the outer call rolls back and throws.
	 * `fn` must be synchronous: a returned thenable rolls back and throws.
	 */
	transaction<T>(fn: () => T): T;
	/** DoltLite: dolt_commit, returns the hash. sqlite: null. */
	seal(message: string): string | null;
	/** DoltLite HEAD hash. sqlite: null. */
	head(): string | null;
	/** Idempotent. */
	close(): void;
}

/** DoltLite only: a read-only reader on `file` as of commit `hash`. */
export type OpenReaderAt = (file: string, hash: string) => SqlDriver;
