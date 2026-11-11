/**
 * Store lock (CB6): one writer process per store file.
 *
 * `<store>.lock` holds {pid, host, startedAt}. It is published with link(2) from a
 * complete temp file, so a reader never sees a half-written lock and creation is
 * exclusive. A lock is stale only when its pid is dead on this machine, or alive but
 * started after the lock was written (a recycled pid); a lock from another machine
 * (`host` is a stable per-user id, see machine-id.ts), or one we cannot parse, is never reclaimed.
 * A reclaim runs under `<store>.lock.reclaim`, linked from the same temp file (so it names its creator): it removes the
 * stale lock only if the file still holds the text we judged. A leftover `.reclaim` is never removed automatically.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { machineId } from "./machine-id.ts";

export interface LockInfo {
	pid: number;
	host: string;
	startedAt: string;
}

/** A `.reclaim` younger than this whose pid is alive is a reclaim in progress, not a leftover. */
const RECLAIM_YOUNG_MS = 30_000;

export class StoreLockedError extends Error {
	constructor(
		readonly file: string,
		readonly holder: LockInfo | null,
		readonly reclaimFile?: string,
		reclaimActive = false,
	) {
		super(
			reclaimFile
				? reclaimActive
					? `${reclaimFile} exists: another process (pid ${holder?.pid}) is reclaiming the lock; try again in a moment`
					: `${reclaimFile} exists: another process is reclaiming the lock, or a reclaim was interrupted${holder ? ` (pid ${holder.pid})` : ""}; delete it if no other process is using the store`
				: holder
				? `${file} is held by pid ${holder.pid} on ${holder.host} (since ${holder.startedAt})`
				: `${file} has an unreadable lock file; delete it if no other process is using the store`,
		);
		this.name = "StoreLockedError";
	}
}

export interface StoreLock {
	readonly lockFile: string;
	/** True only while the lock file still holds exactly this lock's content: false after release, or once evicted. */
	held(): boolean;
	/** Idempotent. Removes the lock only if it is still ours. */
	release(): void;
}

export interface LockEnv {
	pid?: number;
	host?: string;
	isAlive?: (pid: number) => boolean;
	/** When the pid's process started; undefined = unknown (treated as alive). Defaults to none when `isAlive` is injected. */
	processStart?: (pid: number) => Date | undefined;
}

/** `ps -o lstart=` start time. Any failure (no ps, timeout, empty, unparsable) is undefined. Contention path only. */
export function psProcessStart(pid: number): Date | undefined {
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 1000,
			stdio: ["ignore", "pipe", "ignore"],
			// ps prints lstart in its TZ with no zone; pin both sides to UTC so the caller's TZ (and DST) cannot shift it (lh-db2).
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } as unknown as NodeJS.ProcessEnv,
		}).trim();
		const t = Date.parse(`${out} UTC`);
		return out === "" || Number.isNaN(t) ? undefined : new Date(t);
	} catch {
		return undefined;
	}
}

/** EPERM means the process exists but belongs to someone else: alive. */
export function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function lockFileFor(storeFile: string): string {
	return `${storeFile}.lock`;
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function parseLock(text: string): LockInfo | null {
	try {
		const value = JSON.parse(text) as Partial<LockInfo>;
		if (Number.isInteger(value.pid) && typeof value.host === "string" && typeof value.startedAt === "string") return value as LockInfo;
	} catch {
		// fall through
	}
	return null;
}

export function acquireStoreLock(storeFile: string, env: LockEnv = {}): StoreLock {
	const lockFile = lockFileFor(storeFile);
	const pid = env.pid ?? process.pid;
	const host = env.host ?? machineId();
	const isAlive = env.isAlive ?? pidIsAlive;
	const processStart = env.processStart ?? (env.isAlive ? () => undefined : psProcessStart);
	const info: LockInfo = { pid, host, startedAt: new Date().toISOString() };
	const text = JSON.stringify(info);

	const temp = `${lockFile}.${randomUUID()}.tmp`;
	fs.writeFileSync(temp, text, { flag: "wx" });
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				fs.linkSync(temp, lockFile);
				return {
					lockFile,
					held: () => readText(lockFile) === text,
					release() {
						if (readText(lockFile) === text) fs.rmSync(lockFile, { force: true });
					},
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const seen = readText(lockFile);
			if (seen === undefined) continue; // released between link and read: retry
			const holder = parseLock(seen);
			if (holder === null || holder.host !== host) throw new StoreLockedError(storeFile, holder);
			if (isAlive(holder.pid)) {
				// A live pid that started after the lock was written is a recycled pid, not the holder.
				const started = processStart(holder.pid);
				if (started === undefined || !(started.getTime() > Date.parse(holder.startedAt))) throw new StoreLockedError(storeFile, holder);
			}
			// Stale. Judge-and-remove is one step under `.reclaim` (exclusive link): a fresh lock can only appear while the
			// lock file is absent and its text differs from `seen`, so this re-read never removes a live lock.
			const reclaimFile = `${lockFile}.reclaim`;
			try {
				fs.linkSync(temp, reclaimFile);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const other = readText(reclaimFile);
				const otherInfo = other === undefined ? null : parseLock(other);
				let young = false;
				try {
					young = Date.now() - fs.statSync(reclaimFile).mtimeMs < RECLAIM_YOUNG_MS;
				} catch {
					// gone since the read: not active
				}
				throw new StoreLockedError(storeFile, otherInfo, reclaimFile, young && otherInfo !== null && otherInfo.host === host && isAlive(otherInfo.pid));
			}
			try {
				if (readText(lockFile) === seen) fs.rmSync(lockFile, { force: true });
			} finally {
				if (readText(reclaimFile) === text) fs.rmSync(reclaimFile, { force: true }); // only while it still holds our token
			}
		}
		const last = readText(lockFile);
		throw new StoreLockedError(storeFile, last === undefined ? null : parseLock(last));
	} finally {
		fs.rmSync(temp, { force: true });
	}
}
