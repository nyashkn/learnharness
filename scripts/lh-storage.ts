// lh storage commands. M1 extends this file; D4 adds `purge`.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PATHS } from "../config.ts";
import { BACKENDS, markerFile } from "../src/store/marker.ts";
import { openDoltlite } from "../src/store/sql/drivers/doltlite.ts";
import { acquireStoreLock, StoreLockedError, type StoreLock } from "../src/store/sql/lock.ts";
import { PURGE_TEXT, purgeHistory } from "../src/store/sql/purge.ts";

export interface Io {
	out(line: string): void;
	err(line: string): void;
}

/** Missing marker = file (marker.ts). A corrupt marker is refused by the app; here it throws too. */
function markerBackend(dataDir: string): string {
	let text: string;
	try {
		text = fs.readFileSync(markerFile(dataDir), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "file";
		throw error;
	}
	const backend = (JSON.parse(text) as { backend?: unknown }).backend;
	if (typeof backend !== "string" || !(BACKENDS as readonly string[]).includes(backend)) throw new Error(`${markerFile(dataDir)}: unknown backend ${JSON.stringify(backend)}`);
	return backend;
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
	const backend = markerBackend(dataDir);
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
		const db = openDoltlite(store, { lock: locks[1] as StoreLock });
		try {
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
	io.err(command === undefined ? PURGE_TEXT.usage : PURGE_TEXT.unknownCommand(command));
	if (command !== undefined) io.err(PURGE_TEXT.usage);
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = runCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) });
}
