/**
 * Migration runner (architecture 5.1, R1-R5). Generic over store kind: rungs, kind, line format and
 * lh_version all arrive as parameters. Version 0 is "no lh_meta table"; rung 1 creates it.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SqlDriver } from "./driver";
import type { Rung } from "./rung";

export interface MigrateOptions {
	/** Store kind written to lh_meta.store_kind ("graph"). */
	kind: string;
	/** Dense list from version 1. */
	rungs: readonly Rung[];
	lhVersion: string;
	/** Newest line format this build reads. Omit for kinds without one (seeds). */
	lineFormat?: number;
	/** sqlite only, REQUIRED for an upgrade of an existing store (R5: migrate throws before any write without it). Destination of the pre-upgrade `VACUUM INTO`, given the version being left. */
	backupPath?: (fromVersion: number) => string;
	/** DoltLite: receives the HEAD hash recorded before an upgrade. */
	log?: (message: string) => void;
}

export interface MigrateResult {
	from: number;
	to: number;
	applied: number[];
	storeId: string;
}

export type RefusalReason = "newer-schema" | "newer-line-format" | "malformed-meta" | "wrong-kind";

/** R3: the store is not one this build may open, for reads or writes. Thrown before any write. */
export class MigrationRefusedError extends Error {
	constructor(
		readonly reason: RefusalReason,
		message: string,
	) {
		super(message);
		this.name = "MigrationRefusedError";
	}
}

const POSITIVE_INT = /^[1-9]\d{0,9}$/;

/** Normalised sqlite_schema: comments stripped, whitespace collapsed, tables first. The text of snapshot.sql and shapes/. */
export function schemaDump(db: SqlDriver): string {
	const rows = db.all<{ sql: string }>(
		`SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
	);
	return rows.map((r) => `${r.sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim().replace(/;$/, "")};\n`).join("");
}

export const schemaHash = (db: SqlDriver) => createHash("sha256").update(schemaDump(db)).digest("hex");

const hasMeta = (db: SqlDriver) => db.get("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = 'lh_meta'") !== undefined;

function readMeta(db: SqlDriver): Map<string, string> {
	return new Map(db.all<{ key: string; value: string }>("SELECT key, value FROM lh_meta").map((r) => [r.key, r.value]));
}

function parseInt1(value: string | undefined, what: string): number {
	if (value === undefined || !POSITIVE_INT.test(value)) {
		throw new MigrationRefusedError("malformed-meta", `lh_meta.${what} is ${value === undefined ? "missing" : `malformed (${JSON.stringify(value)})`}`);
	}
	return Number(value);
}

/** Validates what is stored; never writes. */
function checkStore(db: SqlDriver, opts: Pick<MigrateOptions, "kind" | "lineFormat">, top: number): number {
	if (!hasMeta(db)) return 0;
	const meta = readMeta(db);
	const version = parseInt1(meta.get("schema_version"), "schema_version");
	if (meta.get("store_kind") !== opts.kind) {
		throw new MigrationRefusedError("wrong-kind", `store_kind is ${JSON.stringify(meta.get("store_kind"))}, expected ${JSON.stringify(opts.kind)}`);
	}
	if (version > top) {
		throw new MigrationRefusedError("newer-schema", `schema_version ${version} is newer than this build (${top})`);
	}
	if (opts.lineFormat !== undefined) {
		const format = parseInt1(meta.get("line_format"), "line_format");
		if (format > opts.lineFormat) {
			throw new MigrationRefusedError("newer-line-format", `line_format ${format} is newer than this build (${opts.lineFormat})`);
		}
	}
	// After the newer checks: a newer build may store these differently. Every rung's writeMeta sets them, so a store without them was not made by this runner.
	if (!/^(0|[1-9]\d{0,14})$/.test(meta.get("revision") ?? "")) throw new MigrationRefusedError("malformed-meta", `lh_meta.revision is ${meta.has("revision") ? `malformed (${JSON.stringify(meta.get("revision"))})` : "missing"}`);
	if (!meta.get("store_id")) throw new MigrationRefusedError("malformed-meta", "lh_meta.store_id is missing");
	return version;
}

function writeMeta(db: SqlDriver, opts: MigrateOptions, rung: Rung): void {
	if (!hasMeta(db)) throw new Error(`rung ${rung.version} (${rung.name}) left no lh_meta table: rung 1 must create it`);
	const set = db.run.bind(db, "INSERT INTO lh_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
	const once = db.run.bind(db, "INSERT OR IGNORE INTO lh_meta(key, value) VALUES (?, ?)");
	once("store_kind", opts.kind);
	once("revision", "0");
	once("store_id", randomUUID());
	if (opts.lineFormat !== undefined) once("line_format", String(opts.lineFormat));
	set("schema_version", String(rung.version));
	set("schema_hash", schemaHash(db));
	set("lh_version", opts.lhVersion);
	set("engine", db.engine);
	set("engine_version", db.engineVersion);
}

function checkRungs(rungs: readonly Rung[]): void {
	if (rungs.length === 0) throw new Error("no rungs");
	rungs.forEach((r, i) => {
		if (r.version !== i + 1) throw new Error(`rungs must be dense and ordered from 1: position ${i} has version ${r.version}`);
	});
}

/** True when `migrate` would write: no lh_meta yet, or a stored version below the top rung. Throws MigrationRefusedError for a store `migrate` would refuse (same read-only checks), so callers can refuse before taking a lock. Never writes. */
export function needsMigration(db: SqlDriver, opts: Pick<MigrateOptions, "rungs" | "kind" | "lineFormat">): boolean {
	return checkStore(db, opts, opts.rungs.length) < opts.rungs.length;
}

/** Brings the store to the top rung. Refusals (R3) happen before any write. */
export function migrate(db: SqlDriver, opts: MigrateOptions): MigrateResult {
	checkRungs(opts.rungs);
	const top = opts.rungs.length;
	const from = checkStore(db, opts, top);

	if (from > 0 && from < top) {
		if (db.engine === "doltlite") opts.log?.(`migrate ${opts.kind} from v${from}: HEAD ${db.head()}`);
		else if (opts.backupPath) db.exec(`VACUUM INTO '${opts.backupPath(from).replaceAll("'", "''")}'`);
		else throw new Error(`migrate ${opts.kind}: upgrading from v${from} to v${top} needs a backupPath (R5: no upgrade without a backup)`);
	}

	const applied: number[] = [];
	for (const rung of opts.rungs.slice(from)) {
		const ran = db.transaction(() => {
			if (checkStore(db, opts, top) >= rung.version) return false; // another opener got here first
			rung.up(db);
			writeMeta(db, opts, rung);
			return true;
		});
		if (!ran) continue;
		applied.push(rung.version);
		db.seal(`migrate ${opts.kind} v${rung.version}: ${rung.name}`);
	}
	const storeId = readMeta(db).get("store_id") as string;
	return { from, to: top, applied, storeId };
}
