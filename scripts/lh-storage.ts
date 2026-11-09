// lh storage commands. M1 extends this file; D4 adds `purge`.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PATHS } from "../config.ts";
import { BACKENDS, markerFile, readMarker, type Backend } from "../src/store/marker.ts";
import { exportStore, MIGRATE_TEXT, migrateBackend } from "../src/store/migrate-backend.ts";
import { assertStoreNotNewer } from "../src/store/sql/graph-store.ts";
import { openDoltlite } from "../src/store/sql/drivers/doltlite.ts";
import { acquireStoreLock, StoreLockedError, type StoreLock } from "../src/store/sql/lock.ts";
import { PURGE_TEXT, purgeHistory } from "../src/store/sql/purge.ts";

export interface Io {
	out(line: string): void;
	err(line: string): void;
}

function purge(args: string[], io: Io): number {
	let dataDir: string = PATHS.data;
	let yes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--yes") yes = true;
		else if (a === "--data-dir" && args[i + 1] !== undefined) dataDir = path.resolve(args[++i] as string);
		else {
			io.err(PURGE_TEXT.usage);
			return 1;
		}
	}
	const backend = readMarker(markerFile(dataDir))?.backend ?? "file"; // missing marker = file; a newer layout or corrupt marker throws
	if (backend !== "doltlite") {
		io.err(PURGE_TEXT.refuseBackend(backend));
		return 1;
	}
	const store = path.join(dataDir, "graph.doltlite");
	if (!fs.existsSync(store)) {
		io.err(PURGE_TEXT.refuseNoStore(store));
		return 1;
	}
	if (!yes) {
		io.out(PURGE_TEXT.explain(store));
		return 2;
	}
	const locks: StoreLock[] = [];
	try {
		try {
			// The app locks the marker file; the driver wants the store's own lock. Take both.
			locks.push(acquireStoreLock(markerFile(dataDir)), acquireStoreLock(store));
		} catch (error) {
			if (!(error instanceof StoreLockedError)) throw error;
			io.err(PURGE_TEXT.refuseLocked(error.message));
			return 1;
		}
		// Refuse a newer store before any writable open: a read-only handle never commits.
		const probe = openDoltlite(store, { readOnly: true });
		try {
			assertStoreNotNewer(probe, store);

		} finally {
			probe.close();
		}
		const db = openDoltlite(store, { lock: locks[1] as StoreLock });
		try {
			db.recover();
			const r = purgeHistory(db, store);
			io.out(PURGE_TEXT.done(r.commitsBefore, r.commitsAfter));
			io.out(PURGE_TEXT.backupSaved(r.backupPath));
		} finally {
			db.close();
		}
		return 0;
	} finally {
		for (const l of locks.reverse()) l.release();
	}
}

function migrate(args: string[], io: Io): number {
	let dataDir: string = PATHS.data;
	let to: string | undefined;
	let allowEmptySource = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--to" && args[i + 1] !== undefined) to = args[++i];
		else if (a === "--allow-empty-source") allowEmptySource = true;
		else if (a === "--data-dir" && args[i + 1] !== undefined) dataDir = path.resolve(args[++i] as string);
		else {
			io.err(MIGRATE_TEXT.usage);
			return 1;
		}
	}
	if (to === undefined || !(BACKENDS as readonly string[]).includes(to)) {
		io.err(MIGRATE_TEXT.usage);
		return 1;
	}
	const r = migrateBackend(dataDir, to as Backend, { allowEmptySource });
	io.out(MIGRATE_TEXT.migrated(r.from, r.to, r.resumed));
	io.out(MIGRATE_TEXT.counts(r.counts));
	io.out(MIGRATE_TEXT.dropped(r.dropped));
	io.out(MIGRATE_TEXT.backup(r.backupDir));
	return 0;
}

function exportCmd(args: string[], io: Io): number {
	let dataDir: string = PATHS.data;
	let out: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--out" && args[i + 1] !== undefined) out = path.resolve(args[++i] as string);
		else if (a === "--data-dir" && args[i + 1] !== undefined) dataDir = path.resolve(args[++i] as string);
		else {
			io.err(MIGRATE_TEXT.exportUsage);
			return 1;
		}
	}
	const r = exportStore(dataDir, out);
	io.out(MIGRATE_TEXT.exported(r.out));
	io.out(MIGRATE_TEXT.counts(r.counts));
	io.out(MIGRATE_TEXT.dropped(r.dropped));
	return 0;
}

export function runCli(argv: string[], io: Io): number {
	const args = argv[0] === "--" ? argv.slice(1) : argv; // pnpm forwards a leading --
	const [command, ...rest] = args;
	if (command === "purge") {
		try {
			return purge(rest, io);
		} catch (error) {
			io.err(`lh purge: ${(error as Error).message}`);
			return 1;
		}
	}
	for (const [name, run] of [["migrate", migrate], ["export", exportCmd]] as const) {
		if (command !== name) continue;
		try {
			return run(rest, io);
		} catch (error) {
			io.err(`lh ${name}: ${(error as Error).message}`);
			return 1;
		}
	}
	if (command !== undefined) io.err(PURGE_TEXT.unknownCommand(command));
	io.err(PURGE_TEXT.usage);
	io.err(MIGRATE_TEXT.usage);
	io.err(MIGRATE_TEXT.exportUsage);
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = runCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) });
}
