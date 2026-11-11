import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDriver, SqlValue } from "../driver";

export interface NodeSqliteOptions {
	/** Open an existing file without write access. */
	readOnly?: boolean;
	/** How long a writer waits on a held write lock before SQLITE_BUSY. Default 5000. */
	busyTimeoutMs?: number;
}

/** node:sqlite driver. Works under ELECTRON_RUN_AS_NODE (engine-facts test 1). */
export function openNodeSqlite(file: string, options: NodeSqliteOptions = {}): SqlDriver {
	const db = new DatabaseSync(file, { readOnly: options.readOnly === true, timeout: options.busyTimeoutMs ?? 5000 });
	let engineVersion: string;
	try {
		// synchronous=FULL: a COMMIT that returned survives power loss. journal_mode is persistent in the file; a read-only handle cannot set it.
		if (options.readOnly !== true) {
			try {
				db.exec("PRAGMA journal_mode = WAL");
			} catch (error) {
				if ((error as { errcode?: number }).errcode !== 5) throw error;
				// The WAL switch upgrades read->write inside SQLite, which skips the busy handler: another opener is converting this file. BEGIN IMMEDIATE waits (busy_timeout applies) for its commit, after which the file is already WAL.
				db.exec("BEGIN IMMEDIATE; COMMIT;");
				db.exec("PRAGMA journal_mode = WAL");
			}
			db.exec("PRAGMA synchronous = FULL;");
		}
		db.exec("PRAGMA foreign_keys = ON;");
		engineVersion = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
	} catch (error) {
		try {
			db.close(); // do not leak the handle (and its file lock) when setup fails
		} catch {
			// the setup error is the one the caller needs
		}
		throw error;
	}

	let depth = 0;
	let doomed = false;
	let closed = false;

	const bind = (params: SqlValue[]) => params as SQLInputValue[];

	const driver = {
		engine: "sqlite",
		engineVersion,
		exec: (sql) => db.exec(sql),
		run: (sql, ...params) => ({ changes: Number(db.prepare(sql).run(...bind(params)).changes) }),
		all: <T>(sql: string, ...params: SqlValue[]) => db.prepare(sql).all(...bind(params)) as T[],
		get: <T>(sql: string, ...params: SqlValue[]) => db.prepare(sql).get(...bind(params)) as T | undefined,
		transaction<T>(fn: () => T): T {
			if (depth > 0) {
				depth++;
				try {
					return checkSync(fn());
				} catch (error) {
					doomed = true;
					throw error;
				} finally {
					depth--;
				}
			}
			db.exec("BEGIN IMMEDIATE");
			depth = 1;
			doomed = false;
			try {
				const result = checkSync(fn());
				if (doomed) throw new Error("transaction rolled back: a nested transaction threw");
				db.exec("COMMIT");
				return result;
			} catch (error) {
				try {
					if (db.isTransaction) db.exec("ROLLBACK");
				} catch {
					// the original error is the one the caller needs
				}
				throw error;
			} finally {
				depth = 0;
				doomed = false;
			}
		},
		seal: () => null,
		head: () => null,
		recover: () => {},
		close() {
			if (closed) return;
			closed = true;
			db.close();
		},
	} satisfies SqlDriver;
	return driver;
}

function checkSync<T>(value: T): T {
	if (value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function") {
		throw new Error("transaction callback returned a promise: it must be synchronous");
	}
	return value;
}
