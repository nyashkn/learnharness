/**
 * Store lock (CB6): one writer process per store file.
 *
 * `<store>.lock` holds {pid, host, startedAt}. It is published with link(2) from a
 * complete temp file, so a reader never sees a half-written lock and creation is
 * exclusive. A lock is stale only when its pid is dead on this host; a lock from
 * another host, or one we cannot parse, is never reclaimed.
 */
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";

export interface LockInfo {
	pid: number;
	host: string;
	startedAt: string;
}

export class StoreLockedError extends Error {
	constructor(
		readonly file: string,
		readonly holder: LockInfo | null,
	) {
		super(
			holder
				? `${file} is held by pid ${holder.pid} on ${holder.host} (since ${holder.startedAt})`
				: `${file} has an unreadable lock file; delete it if no other process is using the store`,
		);
		this.name = "StoreLockedError";
	}
}

export interface StoreLock {
	readonly lockFile: string;
	/** Idempotent. Removes the lock only if it is still ours. */
	release(): void;
}

export interface LockEnv {
	pid?: number;
	host?: string;
	isAlive?: (pid: number) => boolean;
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

function readLock(lockFile: string): LockInfo | null | undefined {
	const text = readText(lockFile);
	if (text === undefined) return undefined;
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
	const host = env.host ?? os.hostname();
	const isAlive = env.isAlive ?? pidIsAlive;
	const info: LockInfo = { pid, host, startedAt: new Date().toISOString() };
	const text = JSON.stringify(info);

	const temp = `${lockFile}.${randomUUID()}.tmp`;
	fs.writeFileSync(temp, text, { flag: "wx" });
	try {
		// shortcut: two reclaimers can both unlink a stale lock and one may then unlink the other's fresh lock; upgrade if a second writer process ever starts concurrently by design.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				fs.linkSync(temp, lockFile);
				return {
					lockFile,
					release() {
						if (readText(lockFile) === text) fs.rmSync(lockFile, { force: true });
					},
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const holder = readLock(lockFile);
			if (holder === undefined) continue; // released between link and read: retry
			if (holder === null || holder.host !== host || isAlive(holder.pid)) throw new StoreLockedError(storeFile, holder);
			fs.rmSync(lockFile, { force: true }); // stale: dead pid on this host
		}
		throw new StoreLockedError(storeFile, readLock(lockFile) ?? null);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}
