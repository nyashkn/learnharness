/**
 * Purge history (D4, architecture 9.1): after a source is deleted its text still sits in dolt_log,
 * dolt_history_* and the old chunks of the file. purgeHistory squashes every commit into root + 1 and
 * runs dolt_gc, so the old text is gone from SQL and from the raw bytes. Only the SqlDriver interface
 * and SQL are used; the caller injects the driver (and holds the store lock).
 */
import fs from "node:fs";
import path from "node:path";
import type { SqlDriver } from "./driver";

const backupSaved = (file: string) => `A backup is saved at ${file}; it still contains the deleted content until you delete that file.`;

/** The backup's name, shared by the dry-run text and the real backup so they cannot drift. */
export function backupPathFor(file: string, stamp: string): string {
	const ext = path.extname(file);
	return path.join(path.dirname(file), `${path.basename(file, ext)}.bak-purge-${stamp}${ext}`);
}

/** Every user-facing purge string, so the final DECISION wording is a one-place edit. */
export const PURGE_TEXT = {
	purgedHistoryMessage: "history purged",
	usage: "usage: lh purge [--data-dir <path>] [--yes]",
	unknownCommand: (name: string) => `lh: unknown command "${name}"`,
	explain: (store: string) =>
		`Purge history permanently erases all earlier versions of your graph, including anything you deleted. This can't be undone. ${backupSaved(backupPathFor(store, "<timestamp>"))}\n` +
		"Close the app, then re-run with --yes to go ahead.",
	refuseBackend: (backend: string) => `lh purge: this data folder uses the ${backend} backend; purge works only on doltlite`,
	refuseNoStore: (store: string) => `lh purge: no store at ${store}`,
	refuseLocked: (reason: string) => `lh purge: the store is in use: ${reason}`,
	done: (before: number, after: number) => `purged: ${before} commits -> ${after}`,
	backupSaved,
	refuseEngine: (engine: string) => `purge needs a doltlite store (got ${engine})`,
	refuseRefs: (refs: string[]) => `purge refused: ${refs.join(", ")} would keep old history reachable; remove them first`,
} as const;

export class PurgeRefusedError extends Error {
	override name = "PurgeRefusedError";
}

export interface PurgeOptions {
	/** Pinned `file@hash` readers; closed first, before anything else touches the store. */
	readers?: SqlDriver[];
	now?: () => Date;
}

export interface PurgeResult {
	backupPath: string;
	commitsBefore: number;
	commitsAfter: number;
	head: string | null;
	gc: string;
}

const quote = (p: string) => `'${p.replaceAll("'", "''")}'`;
const countLog = (db: SqlDriver) => db.get<{ c: number }>("SELECT count(*) AS c FROM dolt_log")?.c ?? 0;

export function purgeHistory(db: SqlDriver, file: string, options: PurgeOptions = {}): PurgeResult {
	if (db.engine !== "doltlite") throw new PurgeRefusedError(PURGE_TEXT.refuseEngine(db.engine));
	// Another branch or a tag keeps old chunks reachable: the promise would be false.
	const refs = [
		...db.all<{ name: string }>("SELECT name FROM dolt_branches").filter((b) => b.name !== "main").map((b) => `branch ${b.name}`),
		...db.all<{ tag_name: string }>("SELECT tag_name FROM dolt_tags").map((t) => `tag ${t.tag_name}`),
	];
	if (refs.length > 0) throw new PurgeRefusedError(PURGE_TEXT.refuseRefs(refs));

	for (const reader of options.readers ?? []) reader.close(); // pinned readers hold old chunks open

	const backupPath = backupPathFor(file, (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-"));
	if (fs.existsSync(backupPath)) throw new Error(`backup ${backupPath} already exists; nothing was changed`);
	db.exec(`VACUUM INTO ${quote(backupPath)}`);
	if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) throw new Error(`backup ${backupPath} was not written; nothing was changed`);

	const commitsBefore = countLog(db);
	const root = db.all<{ commit_hash: string }>("SELECT commit_hash FROM dolt_log").at(-1)?.commit_hash;
	if (!root || !/^[0-9a-z]+$/i.test(root)) throw new Error("purge: cannot find the root commit");
	// No transaction: a crash between reset and commit leaves every row in the working set,
	// and recover-at-open commits it, so no data is lost.
	db.exec(`SELECT dolt_reset('--soft', '${root}')`);
	db.seal(PURGE_TEXT.purgedHistoryMessage);
	const gc = db.get<{ r: string }>("SELECT dolt_gc() AS r")?.r ?? "";
	return { backupPath, commitsBefore, commitsAfter: countLog(db), head: db.head(), gc: String(gc) };
}
