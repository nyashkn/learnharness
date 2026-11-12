import { createRequire } from "node:module";
import type { DatabaseSync as DoltDatabase } from "@dolthub/doltlite";
import type { OpenReaderAt, SqlDriver, SqlValue } from "../driver";
import { lockFileFor, type StoreLock } from "../lock";

export interface DoltliteOptions {
	/** Open an existing file without write access. Never recovers. */
	readOnly?: boolean;
	/** How long a writer waits on a held write lock before "database is locked". Default 5000. */
	busyTimeoutMs?: number;
	/** The store lock this process holds. Only a writable open with a lock recovers a dirty working set. */
	lock?: StoreLock;
}

export const RECOVER_MESSAGE = "recovered at open";

interface Addon {
	DatabaseSync: typeof DoltDatabase;
	version: string;
}

let addon: Addon | undefined;

/** Lazy and memoised: importing this module never touches the native addon (apps on file/sqlite backends run without it). */
function loadAddon(): Addon {
	if (addon) return addon;
	try {
		const require = createRequire(import.meta.url);
		// Untraced on purpose: index.js resolves prebuilds/<platform>-<arch> at runtime, so a traced require
		// sweeps in every platform's prebuild, and Next's trace excludes do not reach instrumentation.ts's
		// trace. next.config.ts outputFileTracingIncludes ships exactly index.js, package.json and this
		// platform's addon; scripts/build-server.mjs refuses anything else.
		const mod = require(/* turbopackIgnore: true */ "@dolthub/doltlite") as { DatabaseSync: typeof DoltDatabase };
		// doltVersion() returns the literal "doltlite-amalgamation", so the package version is the engine version.
		const version = (require(/* turbopackIgnore: true */ "@dolthub/doltlite/package.json") as { version: string }).version;
		addon = { DatabaseSync: mod.DatabaseSync, version };
		return addon;
	} catch (cause) {
		throw new Error(`DoltLite is unavailable: the @dolthub/doltlite addon could not be loaded (${(cause as Error).message})`, { cause });
	}
}

/** DoltLite driver. Same transaction semantics as node-sqlite; seal() is one dolt commit, head() the HEAD commit hash. */
export function openDoltlite(file: string, options: DoltliteOptions = {}): SqlDriver {
	if (options.lock && options.lock.lockFile !== lockFileFor(file)) {
		throw new Error(`lock ${options.lock.lockFile} is not the lock of ${file} (expected ${lockFileFor(file)})`);
	}
	if (options.lock && !options.lock.held()) throw new Error(`lock ${options.lock.lockFile} is not held (released or taken over); refusing to open ${file}`);
	return open(file, options.readOnly === true, options.busyTimeoutMs ?? 5000, options.readOnly === true ? undefined : options.lock);
}

/** A read-only reader on `file` as of commit `hash` (ADR 0005). Never creates a file, never recovers; seal() throws. */
export const openReaderAt: OpenReaderAt = (file, hash) => {
	// The hash is spliced into the path; anything but a plain token could point at another file.
	if (!/^[0-9a-z]+$/i.test(hash)) throw new Error(`invalid commit hash: ${JSON.stringify(hash)}`);
	return open(`${file}@${hash}`, true, 5000, undefined);
};

function open(target: string, readOnly: boolean, busyTimeoutMs: number, recoverLock: StoreLock | undefined): SqlDriver {
	const { DatabaseSync, version } = loadAddon();
	const db = new DatabaseSync(target, { readOnly });
	let depth = 0;
	let doomed = false;
	let closed = false;

	try {
		// DoltLite has no timeout option on the constructor; the pragma is per connection.
		db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)};`);
		// DoltLite reports journal_mode=wal and synchronous=2 (FULL) on its own; setting them is a no-op kept for parity with the twin.
		if (!readOnly) db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
		db.exec("PRAGMA foreign_keys = ON;");
	} catch (error) {
		db.close();
		throw error;
	}

	const big = (sql: string) => {
		const st = db.prepare(sql);
		st.setReadBigInts(true);
		return st;
	};
	const bind = (params: SqlValue[]) => params as never[];
	const dirty = () => db.doltStatus().length > 0;
	const head = () => {
		const [commit] = db.doltLog({ limit: 1 });
		if (!commit) throw new Error("DoltLite store has no commits");
		return commit.commit_hash;
	};

	const driver = {
		engine: "doltlite",
		engineVersion: version,
		exec: (sql) => db.exec(sql),
		run: (sql, ...params) => ({ changes: Number(db.prepare(sql).run(...bind(params)).changes) }),
		all: <T>(sql: string, ...params: SqlValue[]) => big(sql).all(...bind(params)).map(safeRow) as T[],
		get: <T>(sql: string, ...params: SqlValue[]) => {
			const row = big(sql).get(...bind(params));
			return (row === undefined ? undefined : safeRow(row)) as T | undefined;
		},
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
					if (db.inTransaction) db.exec("ROLLBACK");
				} catch {
					// the original error is the one the caller needs
				}
				throw error;
			} finally {
				depth = 0;
				doomed = false;
			}
		},
		seal(message) {
			if (readOnly) throw new Error("seal: this DoltLite handle is read-only");
			// Commit discipline (ADR 0005): seal is after COMMIT, never inside a transaction.
			if (depth > 0 || db.inTransaction) throw new Error("seal: not allowed inside a transaction; seal after COMMIT");
			if (!dirty()) return head(); // dolt_commit on a clean tree throws; an empty commit is never wanted
			return db.doltCommit(message);
		},
		head,
		recover() {
			// The SQL COMMIT succeeded before a crash, so the leftovers are real data. Only a still-held lock holder may commit.
			if (!recoverLock || readOnly || !dirty()) return;
			if (!recoverLock.held()) throw new Error(`recover: lock ${recoverLock.lockFile} is no longer held; the working set is left as it is`);
			db.doltCommit(RECOVER_MESSAGE);
		},
		close() {
			if (closed) return;
			closed = true;
			db.close();
		},
	} satisfies SqlDriver;

	return driver;
}

/** Integers are read as bigint so one beyond 2^53 can be refused (as node:sqlite does) instead of rounded; safe ones become numbers. */
function safeRow(row: unknown): unknown {
	const out = row as Record<string, unknown>;
	for (const key of Object.keys(out)) {
		const v = out[key];
		if (typeof v !== "bigint") continue;
		if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError(`integer ${v} in column "${key}" is beyond 2^53 and cannot be read as a number`);
		out[key] = Number(v);
	}
	return out;
}

function checkSync<T>(value: T): T {
	if (value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function") {
		throw new Error("transaction callback returned a promise: it must be synchronous");
	}
	return value;
}
