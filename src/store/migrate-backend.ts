/**
 * Storage migration tool (M1, bead lh-smv): `lh migrate --to <backend>` and `lh export` (ADR 0004, 0006, 0009).
 *
 * Moves a data folder's graph between file, sqlite and doltlite, and exports it as a plain file-backend
 * folder. High risk: it moves real user data, so every step is ordered to leave the source untouched.
 *
 * Normalisation (architecture 2.1 item 12): CRLF becomes LF, blank lines and a torn tail are dropped and counted,
 * nothing else changes. `export(import(export(x))) == export(x)` byte for byte. Input that cannot be carried unchanged
 * (invalid UTF-8, an SQL row that is not one line of text) refuses the run.
 *
 * migrate order: refusals (no lock, no write) -> locks -> newer probes (read-only) -> snapshot -> journal check ->
 * backup -> one transaction per entity (journal updated after each) -> verify (stored bytes == expected bytes) ->
 * journal removed -> marker written LAST. A crash anywhere reruns: same source + direction resumes, anything else restarts.
 * The source is never written: a file source is only read, an SQL source is only opened read-only. The main store file
 * stays byte-identical; SQLite may still create or update its -wal and -shm files beside a source (owner decision, in the usage text).
 *
 * shortcut: a snapshot holds the whole store in memory (the app's own reader does the same); stream per ledger if stores outgrow RAM.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import pkg from "../../package.json" with { type: "json" };
import { writeFileAtomicSync } from "./atomic-write.ts";
import { assertGraphFormat } from "./graph-format.ts";
import { adapterFor, BACKENDS, CURRENT_LAYOUT, graphFormatFileIn, markerFile, NoAdapterError, readMarker, type Backend } from "./marker.ts";
import { openDoltlite } from "./sql/drivers/doltlite.ts";
import { openNodeSqlite } from "./sql/drivers/node-sqlite.ts";
import type { SqlDriver } from "./sql/driver.ts";
import { assertStoreNotNewer, openGraphStore, type GraphCore } from "./sql/graph-store.ts";
import { acquireStoreLock, type StoreLock } from "./sql/lock.ts";

// ─── text ────────────────────────────────────────────────────────────────────

const SOURCE_NOTE = "The source store file is never changed. SQLite may create or update the -wal and -shm files beside it; that changes no data.";

/** Every user-facing string of the two commands, one place (the way PURGE_TEXT does it). */
export const MIGRATE_TEXT = {
	usage: `usage: lh migrate --to <file|sqlite|doltlite> [--data-dir <path>] [--allow-empty-source]\n  An empty source refuses to replace a target that holds data unless --allow-empty-source is passed.\n  ${SOURCE_NOTE}`,
	exportUsage: `usage: lh export [--out <dir>] [--data-dir <path>]\n  ${SOURCE_NOTE}`,
	noDataDir: (dir: string) => `the data folder ${dir} does not exist`,
	doltliteTarget: (host: string) => `DoltLite runs only on macOS arm64 in this build (this machine is ${host}), so the app could not open the folder after migrating; nothing was changed. DoltLite as a source (the exit path) works`,
	sameBackend: (backend: string) => `the data folder already uses the ${backend} backend; nothing to migrate`,
	missingStore: (store: string, backend: string) => `the marker names ${backend} but ${store} is missing; restore it before migrating or exporting`,
	markerChanged: "the storage marker changed while taking the locks; nothing was changed, run again",
	badSources: (file: string, why: string) => `${file} ${why}; refusing, because the app would read it as empty and the sources would be lost`,
	badJson: (file: string) => `${file} is not valid JSON; refusing, so nothing is lost silently`,
	notUtf8: (file: string, where?: string) => `${file}${where === undefined ? "" : ` ${where}`} is not valid UTF-8; refusing, because carrying it over would change its bytes. Nothing was changed`,
	notText: (file: string, where: string, type: string) => `${file} ${where} holds ${type}, not text; refusing, because exporting it would change it. Nothing was changed`,
	illFormed: (file: string, where: string) => `${file} ${where} holds a lone surrogate, which cannot be stored in SQL unchanged; refusing. Nothing was changed`,
	multiline: (file: string, where: string) => `${file} ${where} holds a line break, so it is not one ledger line; refusing, because exporting it would split it. Nothing was changed`,
	emptySource: (backend: string) => `the source holds no data but the ${backend} target does, and migrating would replace it with nothing. Nothing was changed. Pass --allow-empty-source if that is what you want`,
	badFormat: (file: string, version: number) => `${file} has version ${version}; a format version must be a positive integer`,
	notAStore: (file: string) => `${file} is not a LearnHarness graph store (no lh_meta table)`,
	badMeta: (file: string, key: string, value: string | undefined) => `${file}: lh_meta.${key} is ${value === undefined ? "missing" : JSON.stringify(value)}`,
	unknownTable: (file: string, table: string) => `${file} has a table this build does not know (${table}); refusing, so a newer layout is not lost silently`,
	unknownDocument: (file: string, key: string) => `${file} has a documents row this build does not know (${key}); refusing, so it is not lost silently`,
	badRecord: (file: string, what: string, id: string) => `${file}: ${what} ${JSON.stringify(id)} holds invalid JSON; refusing`,
	outNotEmpty: (out: string) => `${out} already exists and is not empty; an export never overwrites`,
	verifyFailed: (path: string) => `verification failed: the target differs from the source at ${path}; the marker was NOT written, the source is untouched, and the backup is kept; run again to restart from a fresh backup`,
	migrated: (from: string, to: string, resumed: boolean) => `migrated ${from} -> ${to}${resumed ? " (resumed an interrupted run)" : ""}`,
	counts: (c: Counts) => `  nodes ${c.nodes}, chains ${c.chains}, sessions ${c.checkpoints}, coverage ${c.coverage}, sources ${c.sources}`,
	dropped: (d: Dropped) => `  normalised: ${d.crlf} CRLF line ends, ${d.blank} blank lines dropped, ${d.torn} torn tail lines dropped`,
	backup: (dir: string) => `  backup of the previous state: ${dir}`,
	exported: (out: string) => `exported to ${out}`,
} as const;

export class MigrateRefusedError extends Error {
	override name = "MigrateRefusedError";
}

// ─── normaliser ──────────────────────────────────────────────────────────────

export interface Dropped {
	crlf: number;
	blank: number;
	torn: number;
}

/**
 * The one defined normalisation of a ledger. Split on "\n"; trailing "\r"s of a segment are stripped (counted once per segment);
 * the final "" is the terminator, not a blank; a blank segment is dropped; an unterminated final segment that does not parse is a torn
 * append and is dropped, one that parses is KEPT (the app's reader shows it). Everything else, corrupt lines included, stays byte for byte.
 * ALL trailing "\r"s go, not one: a kept line may then never end in "\r", which is what makes a second pass change nothing.
 */
export function normaliseLedger(text: string): Dropped & { lines: string[] } {
	const segments = text.split("\n");
	const lines: string[] = [];
	const out: Dropped = { crlf: 0, blank: 0, torn: 0 };
	segments.forEach((raw, i) => {
		const last = i === segments.length - 1;
		if (last && raw === "") return;
		const seg = raw.replace(/\r+$/, "");
		if (seg !== raw) out.crlf++;
		if (seg.trim() === "") {
			out.blank++;
			return;
		}
		if (last) {
			try {
				JSON.parse(seg.trim());
			} catch {
				out.torn++;
				return;
			}
		}
		lines.push(seg);
	});
	return { lines, ...out };
}

// ─── snapshot and export rendering ───────────────────────────────────────────

type Ledger = "nodes" | "chains" | "coverage" | "checkpoints";
/** The one table of ledgers: entity name, file under graph/, table in the SQL stores. */
const LEDGERS: readonly { entity: Ledger; file: string; table: string }[] = [
	{ entity: "nodes", file: "nodes.jsonl", table: "ledger_nodes" },
	{ entity: "chains", file: "chains.jsonl", table: "ledger_chains" },
	{ entity: "checkpoints", file: "sessions.jsonl", table: "ledger_checkpoints" },
	{ entity: "coverage", file: "coverage.jsonl", table: "ledger_coverage" },
];
/** Order of the entity transactions. */
const ENTITIES = ["meta", "nodes", "chains", "coverage", "checkpoints", "sources", "organization"] as const;
type Entity = (typeof ENTITIES)[number];
const ORG_KEY = "source-organization";
/** Files of the graph family that stay files on every backend: copied by export, never migrated. */
const SIDE_FILES = ["positions.json", "render-settings.json"];
const FAMILY_FILES = [...LEDGERS.map((l) => l.file), "sources.json", "source-organization.json", "format.json"];

export interface Counts {
	nodes: number;
	chains: number;
	checkpoints: number;
	coverage: number;
	sources: number;
}
export interface Snapshot {
	lineFormat: number;
	ledgers: Record<Ledger, string[]>;
	sources: [string, unknown][];
	/** undefined = no document; null is a real value. */
	organization: { value: unknown } | undefined;
	dropped: Dropped;
}

const SourcesShape = Type.Record(Type.String(), Type.Unknown());

function readBytes(file: string): Buffer | undefined {
	try {
		return fs.readFileSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** undefined when the bytes are not valid UTF-8: nothing is ever rewritten as U+FFFD. ignoreBOM keeps a BOM as content. */
function utf8(bytes: Uint8Array): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

/** A JSON document or a stamp. */
function readText(file: string): string | undefined {
	const bytes = readBytes(file);
	if (bytes === undefined) return undefined;
	const text = utf8(bytes);
	if (text === undefined) throw new MigrateRefusedError(MIGRATE_TEXT.notUtf8(file));
	return text;
}

/** A crash can cut an append inside a character: valid UTF-8 up to an unfinished last character. */
function endsInsideCharacter(tail: Uint8Array): boolean {
	if (tail.length === 0 || utf8(tail) !== undefined) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(tail, { stream: true });
		return true;
	} catch {
		return false;
	}
}

function firstBadLine(bytes: Buffer): number {
	for (let line = 1, start = 0; ; line++) {
		const newline = bytes.indexOf(0x0a, start);
		if (newline === -1 || utf8(bytes.subarray(start, newline)) === undefined) return line;
		start = newline + 1;
	}
}

/** Invalid UTF-8 refuses: a TEXT column cannot carry it unchanged and the defined normalisation does not cover it. An append cut inside a character IS a torn tail, so it is dropped and counted. */
function readLedger(file: string): Dropped & { lines: string[] } {
	const bytes = readBytes(file) ?? Buffer.alloc(0);
	const body = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
	const cut = endsInsideCharacter(bytes.subarray(body.length));
	const text = utf8(cut ? body : bytes);
	if (text === undefined) throw new MigrateRefusedError(MIGRATE_TEXT.notUtf8(file, `line ${firstBadLine(bytes)}`));
	const n = normaliseLedger(text);
	return cut ? { ...n, torn: n.torn + 1 } : n;
}
function parseJson(file: string, text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new MigrateRefusedError(MIGRATE_TEXT.badJson(file));
	}
}
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function add(total: Dropped, d: Dropped): void {
	total.crlf += d.crlf;
	total.blank += d.blank;
	total.torn += d.torn;
}

/** Read the file backend: graph/*. Refuses what the app would silently read as empty. */
export function snapshotFile(dataDir: string): Snapshot {
	const g = path.join(dataDir, "graph");
	const dropped: Dropped = { crlf: 0, blank: 0, torn: 0 };
	const ledgers = {} as Record<Ledger, string[]>;
	for (const l of LEDGERS) {
		const n = readLedger(path.join(g, l.file));
		ledgers[l.entity] = n.lines;
		add(dropped, n);
	}
	const sourcesFile = path.join(g, "sources.json");
	const sourcesText = readText(sourcesFile);
	let sources: [string, unknown][] = [];
	if (sourcesText !== undefined) {
		const parsed = parseJson(sourcesFile, sourcesText);
		if (!isPlainObject(parsed) || !Value.Check(SourcesShape, parsed)) throw new MigrateRefusedError(MIGRATE_TEXT.badSources(sourcesFile, "is not a JSON object"));
		sources = Object.entries(parsed); // entries the app's guard would skip are kept: dropping them would lose data
	}
	const orgFile = path.join(g, "source-organization.json");
	const orgText = readText(orgFile);
	const organization = orgText === undefined ? undefined : { value: parseJson(orgFile, orgText) };
	// graph-format.ts stampedVersion: absent, corrupt or non-integer = v1
	const formatFile = path.join(g, "format.json");
	let lineFormat = 1;
	const formatText = readText(formatFile);
	if (formatText !== undefined) {
		try {
			const v = (JSON.parse(formatText) as { version?: unknown } | null)?.version;
			if (typeof v === "number" && Number.isInteger(v)) lineFormat = v;
		} catch {
			// corrupt = v1
		}
	}
	if (lineFormat < 1) throw new MigrateRefusedError(MIGRATE_TEXT.badFormat(formatFile, lineFormat));
	return { lineFormat, ledgers, sources, organization, dropped };
}

const KNOWN_TABLES = new Set(["lh_meta", "sources", "documents", ...LEDGERS.map((l) => l.table)]);

const openReadOnly = (file: string, backend: "sqlite" | "doltlite"): SqlDriver =>
	backend === "sqlite" ? openNodeSqlite(file, { readOnly: true }) : openDoltlite(file, { readOnly: true });

interface Cell {
	type: string;
	bytes: Uint8Array;
}
/** Each row's columns as stored: storage class plus exact bytes, nothing decoded yet. */
function rawRows(db: SqlDriver, table: string, columns: readonly string[], order = ""): Cell[][] {
	const select = columns.map((c, i) => `typeof(${c}) AS t${i}, CAST(${c} AS BLOB) AS b${i}`).join(", ");
	return db.all<Record<string, unknown>>(`SELECT ${select} FROM ${table} ${order}`).map((row) => columns.map((_, i) => ({ type: String(row[`t${i}`]), bytes: row[`b${i}`] as Uint8Array })));
}

/** rawRows decoded strictly. A value that is not text, or not valid UTF-8, refuses: reading it would change it. */
function textRows(db: SqlDriver, file: string, table: string, columns: readonly string[], order = ""): string[][] {
	return rawRows(db, table, columns, order).map((cells, row) =>
		cells.map(({ type, bytes }, c) => {
			const where = `${table}.${columns[c]} row ${row + 1}`;
			if (type !== "text") throw new MigrateRefusedError(MIGRATE_TEXT.notText(file, where, type));
			const text = utf8(bytes);
			if (text === undefined) throw new MigrateRefusedError(MIGRATE_TEXT.notUtf8(file, where));
			return text;
		}),
	);
}

/** Read an SQL store READ-ONLY (a writable DoltLite open appends bytes). Reads the working set, so uncommitted rows count. */
export function snapshotSql(file: string, backend: "sqlite" | "doltlite"): Snapshot {
	const db = openReadOnly(file, backend);
	try {
		const tables = db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table'").map((r) => r.name);
		if (!tables.includes("lh_meta")) throw new MigrateRefusedError(MIGRATE_TEXT.notAStore(file));
		for (const t of tables) if (!t.startsWith("sqlite_") && !t.startsWith("dolt_") && !KNOWN_TABLES.has(t)) throw new MigrateRefusedError(MIGRATE_TEXT.unknownTable(file, t));
		const format = db.get<{ value: string }>("SELECT value FROM lh_meta WHERE key = 'line_format'")?.value;
		if (format === undefined || !/^[1-9]\d{0,9}$/.test(format)) throw new MigrateRefusedError(MIGRATE_TEXT.badMeta(file, "line_format", format));
		const dropped: Dropped = { crlf: 0, blank: 0, torn: 0 };
		const ledgers = {} as Record<Ledger, string[]>;
		for (const l of LEDGERS) {
			const rows = textRows(db, file, l.table, ["line_json"], "ORDER BY seq").map(([line], i) => {
				if ((line as string).includes("\n")) throw new MigrateRefusedError(MIGRATE_TEXT.multiline(file, `${l.table}.line_json row ${i + 1}`));
				return line as string;
			});
			const n = normaliseLedger(rows.length === 0 ? "" : `${rows.join("\n")}\n`); // the same normaliser, so the first export is already a fixed point
			ledgers[l.entity] = n.lines;
			add(dropped, n);
		}
		const sources = textRows(db, file, "sources", ["id", "record_json"]).map(([id, record]): [string, unknown] => {
			try {
				return [id as string, JSON.parse(record as string)];
			} catch {
				throw new MigrateRefusedError(MIGRATE_TEXT.badRecord(file, "source", id as string));
			}
		});
		let organization: Snapshot["organization"];
		for (const [key, json] of textRows(db, file, "documents", ["key", "json"])) {
			if (key !== ORG_KEY) throw new MigrateRefusedError(MIGRATE_TEXT.unknownDocument(file, key as string));
			try {
				organization = { value: JSON.parse(json as string) };
			} catch {
				throw new MigrateRefusedError(MIGRATE_TEXT.badRecord(file, "document", key));
			}
		}
		return { lineFormat: Number(format), ledgers, sources, organization, dropped };
	} finally {
		db.close();
	}
}

const holdsData = (s: Snapshot): boolean => s.sources.length > 0 || s.organization !== undefined || LEDGERS.some((l) => s.ledgers[l.entity].length > 0);
const countsOf = (s: Snapshot): Counts => ({ nodes: s.ledgers.nodes.length, chains: s.ledgers.chains.length, checkpoints: s.ledgers.checkpoints.length, coverage: s.ledgers.coverage.length, sources: s.sources.length });

/** relative path -> exact text of a file-backend folder, in path order. No marker. positions and render settings are not in it (copied bytes). */
export function renderExport(s: Snapshot): Map<string, string> {
	const files = new Map<string, string>();
	for (const l of LEDGERS) files.set(`graph/${l.file}`, s.ledgers[l.entity].map((x) => `${x}\n`).join(""));
	const sorted = [...s.sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); // DECISION lh-ezi: SQL source order is unspecified on DoltLite
	files.set("graph/sources.json", JSON.stringify(Object.fromEntries(sorted), null, "\t")); // same bytes as writeSourceMap
	if (s.organization) files.set("graph/source-organization.json", `${JSON.stringify(s.organization.value, null, "\t")}\n`);
	files.set("graph/format.json", `${JSON.stringify({ version: s.lineFormat }, null, "\t")}\n`);
	return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function fingerprint(files: Map<string, string>): string {
	const h = createHash("sha256");
	for (const [p, text] of files) h.update(`${p}\0${Buffer.byteLength(text)}\0${text}\0`);
	return h.digest("hex");
}

// ─── stores and refusals ─────────────────────────────────────────────────────

type SqlBackend = "sqlite" | "doltlite";
const isSql = (b: Backend): b is SqlBackend => b !== "file";
const storeFile = (dataDir: string, b: SqlBackend): string => path.join(dataDir, b === "sqlite" ? "graph.sqlite" : "graph.doltlite");
const stamp = (d: Date): string => d.toISOString().replace(/[:.]/g, "-");

function requireDataDir(dataDir: string): void {
	if (!fs.statSync(dataDir, { throwIfNoEntry: false })?.isDirectory()) throw new MigrateRefusedError(MIGRATE_TEXT.noDataDir(dataDir));
}

type Marker = ReturnType<typeof readMarker>;

/** Refusals shared by both entry points, in order: no lock and no write yet. Returns the ONE marker read of the run: the backend comes from it and it is what is compared under the locks. */
function refusals(dataDir: string): { marker: Marker; backend: Backend } {
	requireDataDir(dataDir);
	const marker = readMarker(markerFile(dataDir)); // a newer layout or a corrupt marker throws
	assertGraphFormat(graphFormatFileIn(dataDir)); // every backend: render settings and positions stay files, and `file` is valid = not stamped newer
	const backend = marker?.backend ?? "file";
	if (isSql(backend) && !fs.existsSync(storeFile(dataDir, backend))) throw new MigrateRefusedError(MIGRATE_TEXT.missingStore(storeFile(dataDir, backend), backend));
	return { marker, backend };
}

/** READ-ONLY: a store newer than this build refuses before anything is written. */
function probe(file: string, backend: SqlBackend): void {
	const db = openReadOnly(file, backend);
	try {
		assertStoreNotNewer(db, file);
	} finally {
		db.close();
	}
}

function snapshotOf(dataDir: string, backend: Backend): Snapshot {
	return isSql(backend) ? snapshotSql(storeFile(dataDir, backend), backend) : snapshotFile(dataDir);
}

class Locks {
	private held = new Map<string, StoreLock>();
	take(storeFileOrMarker: string): StoreLock {
		const known = this.held.get(storeFileOrMarker);
		if (known) return known;
		const lock = acquireStoreLock(storeFileOrMarker);
		this.held.set(storeFileOrMarker, lock);
		return lock;
	}
	releaseAll(): void {
		for (const l of [...this.held.values()].reverse()) l.release();
		this.held.clear();
	}
}

const sameMarker = (a: Marker, b: Marker): boolean => JSON.stringify(a) === JSON.stringify(b);

// ─── export ──────────────────────────────────────────────────────────────────

export interface ExportOptions {
	/** Tests only: called at after-refusals and after-lock. */
	checkpoint?: (name: string) => void;
	now?: () => Date;
}
export interface ExportReport {
	out: string;
	counts: Counts;
	dropped: Dropped;
}

/** Write the store as a plain file-backend folder (graph/*), no marker. Built beside `out` and renamed in, so a half export is never mistaken for a whole one. */
export function exportStore(dataDirIn: string, outIn?: string, options: ExportOptions = {}): ExportReport {
	const dataDir = path.resolve(dataDirIn);
	const { marker, backend } = refusals(dataDir);
	options.checkpoint?.("after-refusals");
	const out = path.resolve(outIn ?? path.join(dataDir, `export-${stamp((options.now ?? (() => new Date()))())}`));
	const existing = fs.statSync(out, { throwIfNoEntry: false });
	if (existing && (!existing.isDirectory() || fs.readdirSync(out).length > 0)) throw new MigrateRefusedError(MIGRATE_TEXT.outNotEmpty(out));

	const mfile = markerFile(dataDir);
	const locks = new Locks();
	try {
		locks.take(mfile);
		if (isSql(backend)) locks.take(storeFile(dataDir, backend));
		options.checkpoint?.("after-lock");
		if (!sameMarker(marker, readMarker(mfile))) throw new MigrateRefusedError(MIGRATE_TEXT.markerChanged);
		if (isSql(backend)) probe(storeFile(dataDir, backend), backend);
		const snap = snapshotOf(dataDir, backend);
		const files = renderExport(snap);

		fs.mkdirSync(path.dirname(out), { recursive: true });
		const tmp = `${out}.tmp-${randomUUID()}`;
		try {
			fs.mkdirSync(tmp);
			for (const [rel, text] of files) {
				fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
				fs.writeFileSync(path.join(tmp, rel), text, "utf8");
			}
			for (const name of SIDE_FILES) {
				const src = path.join(dataDir, "graph", name);
				if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, "graph", name));
			}
			fs.renameSync(tmp, out);
		} catch (error) {
			fs.rmSync(tmp, { recursive: true, force: true });
			throw error;
		}
		return { out, counts: countsOf(snap), dropped: snap.dropped };
	} finally {
		locks.releaseAll();
	}
}

// ─── migrate ─────────────────────────────────────────────────────────────────

const JournalSchema = Type.Object({
	version: Type.Literal(1),
	from: Type.Union(BACKENDS.map((b) => Type.Literal(b))),
	to: Type.Union(BACKENDS.map((b) => Type.Literal(b))),
	fingerprint: Type.String(),
	backupDir: Type.String(),
	done: Type.Array(Type.String()),
});
interface Journal {
	version: 1;
	from: Backend;
	to: Backend;
	fingerprint: string;
	backupDir: string;
	done: string[];
}
const journalFile = (dataDir: string): string => path.join(dataDir, "storage-migrate.journal.json");
function readJournal(file: string): Journal | undefined {
	const bytes = readBytes(file);
	if (bytes === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(bytes.toString("utf8"));
		return Value.Check(JournalSchema, value) ? (value as Journal) : undefined;
	} catch {
		return undefined; // a corrupt journal is a fresh run
	}
}
const writeJournal = (file: string, j: Journal): void => writeFileAtomicSync(file, `${JSON.stringify(j, null, "\t")}\n`, { allowInPlaceFallback: true });

export interface MigrateOptions {
	/** Tests only: called at after-refusals, after-lock, after-backup, after-journal, commit:<entity>, after:<entity>, before-verify, after-verify, after-journal-removed, after-marker. A throw is a crash. */
	checkpoint?: (name: string) => void;
	now?: () => Date;
	/** `--allow-empty-source`: let a source with no data replace a target that holds data. */
	allowEmptySource?: boolean;
}
export interface MigrateReport {
	from: Backend;
	to: Backend;
	resumed: boolean;
	backupDir: string;
	counts: Counts;
	dropped: Dropped;
}

function copyKeepMode(src: string, dst: string): void {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.copyFileSync(src, dst);
	fs.chmodSync(dst, fs.statSync(src).mode & 0o777); // 0600 stays 0600
}

/** Copy the source into backup/source and set the pre-existing target aside in backup/target. The source is only read. */
function backUp(dataDir: string, from: Backend, to: Backend, dir: string): void {
	const src = path.join(dir, "source");
	const tgt = path.join(dir, "target");
	if (isSql(from)) {
		for (const suffix of ["", "-wal"]) {
			const f = `${storeFile(dataDir, from)}${suffix}`;
			if (fs.existsSync(f)) copyKeepMode(f, path.join(src, path.basename(f)));
		}
	} else {
		for (const name of [...FAMILY_FILES, ...SIDE_FILES]) {
			const f = path.join(dataDir, "graph", name);
			if (fs.existsSync(f)) copyKeepMode(f, path.join(src, "graph", name));
		}
	}
	if (isSql(to)) {
		for (const suffix of ["", "-wal", "-shm"]) {
			const f = `${storeFile(dataDir, to)}${suffix}`;
			if (!fs.existsSync(f)) continue;
			fs.mkdirSync(tgt, { recursive: true });
			fs.renameSync(f, path.join(tgt, path.basename(f)));
		}
	} else {
		for (const name of FAMILY_FILES) {
			const f = path.join(dataDir, "graph", name);
			if (fs.existsSync(f)) copyKeepMode(f, path.join(tgt, "graph", name)); // overwritten below; a stale source-organization.json is removed
		}
	}
}

interface Target {
	write(entity: Entity): void;
	close(): void;
}

function sqlTarget(dataDir: string, to: SqlBackend, snap: Snapshot, lock: StoreLock | undefined, backupDir: string): Target {
	const file = storeFile(dataDir, to);
	let db: SqlDriver | undefined;
	let core: GraphCore | undefined;
	const open = (): GraphCore => {
		if (core) return core;
		const d = to === "sqlite" ? openNodeSqlite(file) : openDoltlite(file, { lock });
		try {
			core = openGraphStore({
				db: d,
				file,
				lhVersion: pkg.version,
				positions: { read: () => ({}), write: () => {} }, // positions stay a file and are not migrated
				log: () => {},
				backupPath: (v) => path.join(backupDir, `target-upgrade-from-v${v}.sqlite`),
			}).core;
		} catch (error) {
			d.close();
			throw error;
		}
		db = d;
		return core;
	};
	const rows = (table: string, lines: readonly string[], c: GraphCore): number => {
		let changes = c.db.run(`DELETE FROM ${table}`).changes;
		lines.forEach((line, i) => {
			changes += c.db.run(`INSERT INTO ${table} (seq, line_json) VALUES (?, ?)`, i + 1, line).changes; // explicit seq: a rerun lands on the same rows
		});
		return changes;
	};
	return {
		write(entity) {
			const c = open();
			c.bare(`migrate: ${entity}`, () => {
				let changes = 0;
				if (entity === "meta") {
					const cur = c.db.get<{ value: string }>("SELECT value FROM lh_meta WHERE key = 'line_format'")?.value;
					if (cur !== String(snap.lineFormat)) {
						c.db.run("INSERT INTO lh_meta (key, value) VALUES ('line_format', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(snap.lineFormat));
						changes++;
					}
				} else if (entity === "sources") {
					changes += c.db.run("DELETE FROM sources").changes;
					for (const [id, record] of snap.sources) changes += c.db.run("INSERT INTO sources (id, record_json) VALUES (?, ?)", id, JSON.stringify(record)).changes;
				} else if (entity === "organization") {
					changes += c.db.run("DELETE FROM documents WHERE key = ?", ORG_KEY).changes;
					if (snap.organization) changes += c.db.run("INSERT INTO documents (key, json) VALUES (?, ?)", ORG_KEY, JSON.stringify(snap.organization.value)).changes;
				} else {
					const l = LEDGERS.find((x) => x.entity === entity)!;
					changes += rows(l.table, snap.ledgers[l.entity], c);
				}
				if (changes > 0) c.changed();
			});
		},
		close: () => db?.close(),
	};
}

const FILE_OF: Record<Entity, string> = {
	meta: "graph/format.json",
	nodes: "graph/nodes.jsonl",
	chains: "graph/chains.jsonl",
	coverage: "graph/coverage.jsonl",
	checkpoints: "graph/sessions.jsonl",
	sources: "graph/sources.json",
	organization: "graph/source-organization.json",
};

function fileTarget(dataDir: string, rendered: Map<string, string>): Target {
	return {
		write(entity) {
			const file = path.join(dataDir, FILE_OF[entity]);
			const text = rendered.get(FILE_OF[entity]);
			if (text === undefined) {
				fs.rmSync(file, { force: true }); // no document in the source: a stale one in the target goes (it is in the backup)
				return;
			}
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileAtomicSync(file, text, { allowInPlaceFallback: true });
		},
		close: () => {},
	};
}

// Verify strictly decodes what is stored and compares it with the expected text, never through the reader or the normaliser: a check built on them cannot see what they remove.
// Never re-encode the expected text to compare: Buffer.from turns a lone surrogate into U+FFFD just as the driver does, so both sides would agree after losing the same data.

function fileDifference(dataDir: string, rendered: Map<string, string>): string | undefined {
	for (const name of FAMILY_FILES) {
		const rel = `graph/${name}`;
		const want = rendered.get(rel);
		const got = readBytes(path.join(dataDir, rel));
		if (want === undefined ? got !== undefined : got === undefined || utf8(got) !== want) return rel;
	}
	return undefined;
}

/** Every value a SQL target must hold, table by table. `file` is where a file source keeps it. */
function sqlRows(snap: Snapshot) {
	const byId = [...snap.sources].sort(([a], [b]) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
	return [
		...LEDGERS.map((l) => ({ file: l.file, table: l.table, columns: ["line_json"], order: "ORDER BY seq", want: snap.ledgers[l.entity].map((line) => [line]) })),
		{ file: "sources.json", table: "sources", columns: ["id", "record_json"], order: "ORDER BY CAST(id AS BLOB)", want: byId.map(([id, record]) => [id, JSON.stringify(record)]) },
		{ file: "source-organization.json", table: "documents", columns: ["key", "json"], order: "", want: snap.organization ? [[ORG_KEY, JSON.stringify(snap.organization.value)]] : [] },
	];
}

/** Before anything is written: a lone surrogate (JSON.parse makes one from a \\ud800 escape) cannot be encoded to UTF-8 unchanged, and the driver would store U+FFFD for it. */
function refuseIllFormed(snap: Snapshot, originOf: (file: string) => string): void {
	for (const { file, table, columns, want } of sqlRows(snap)) {
		for (const row of want) {
			row.forEach((value, c) => {
				if (/\p{Surrogate}/u.test(value)) throw new MigrateRefusedError(MIGRATE_TEXT.illFormed(originOf(file), `${table}.${columns[c]} of ${JSON.stringify((row[0] as string).slice(0, 100))}`));
			});
		}
	}
}

export function sqlDifference(file: string, backend: SqlBackend, snap: Snapshot): string | undefined {
	const db = openReadOnly(file, backend);
	try {
		for (const { table, columns, order, want } of sqlRows(snap)) {
			const got = rawRows(db, table, columns, order);
			const same = got.length === want.length && got.every((cells, r) => cells.every((cell, c) => cell.type === "text" && utf8(cell.bytes) === want[r]?.[c]));
			if (!same) return table;
		}
		return db.get<{ value: string }>("SELECT value FROM lh_meta WHERE key = 'line_format'")?.value === String(snap.lineFormat) ? undefined : "lh_meta.line_format";
	} finally {
		db.close();
	}
}

export function migrateBackend(dataDirIn: string, to: Backend, options: MigrateOptions = {}): MigrateReport {
	const dataDir = path.resolve(dataDirIn);
	const checkpoint = options.checkpoint ?? (() => {});
	const now = options.now ?? (() => new Date());

	// a. refusals: before any write or lock
	if (!(BACKENDS as readonly string[]).includes(to)) throw new MigrateRefusedError(MIGRATE_TEXT.usage);
	// The app's own platform rule: where it refuses a DoltLite folder (until D5), migrating there would lock the user out.
	if (to === "doltlite") {
		try {
			adapterFor("doltlite", markerFile(dataDir));
		} catch (error) {
			if (!(error instanceof NoAdapterError)) throw error;
			throw new MigrateRefusedError(MIGRATE_TEXT.doltliteTarget(`${process.platform}-${process.arch}`));
		}
	}
	const { marker, backend: from } = refusals(dataDir);
	if (from === to) throw new MigrateRefusedError(MIGRATE_TEXT.sameBackend(from));
	checkpoint("after-refusals");
	const mfile = markerFile(dataDir);

	const locks = new Locks();
	let target: Target | undefined;
	try {
		// b. locks, marker re-read under them
		locks.take(mfile);
		const sql = [from, to].filter(isSql);
		for (const b of sql) locks.take(storeFile(dataDir, b));
		checkpoint("after-lock");
		if (!sameMarker(marker, readMarker(mfile))) throw new MigrateRefusedError(MIGRATE_TEXT.markerChanged);

		// c. under the lock, still before any change: newer stores refuse (source, and a target that already exists)
		if (isSql(from)) probe(storeFile(dataDir, from), from);
		if (isSql(to) && fs.existsSync(storeFile(dataDir, to))) probe(storeFile(dataDir, to), to);

		// d. snapshot
		const snap = snapshotOf(dataDir, from);
		const rendered = renderExport(snap);
		const fp = fingerprint(rendered);
		if (isSql(to)) refuseIllFormed(snap, (name) => (isSql(from) ? storeFile(dataDir, from) : path.join(dataDir, "graph", name)));

		// An empty source would replace real data with nothing. The check reads only: nothing has been changed yet.
		if (options.allowEmptySource !== true && !holdsData(snap) && (to === "file" || fs.existsSync(storeFile(dataDir, to))) && holdsData(snapshotOf(dataDir, to))) throw new MigrateRefusedError(MIGRATE_TEXT.emptySource(to));

		// e. journal: same direction and same source resumes, anything else is a fresh run
		const jfile = journalFile(dataDir);
		const prior = readJournal(jfile);
		const targetSurvived = (done: readonly string[]): boolean => done.length === 0 || (isSql(to) ? fs.existsSync(storeFile(dataDir, to)) : (done as Entity[]).every((e) => !rendered.has(FILE_OF[e]) || fs.existsSync(path.join(dataDir, FILE_OF[e]))));
		const resumed = prior !== undefined && prior.from === from && prior.to === to && prior.fingerprint === fp && fs.existsSync(prior.backupDir) && targetSurvived(prior.done);
		let journal: Journal;
		if (resumed) {
			journal = prior!;
		} else {
			// f. fresh run: backup first
			const backups = path.join(dataDir, "migrate-backups");
			fs.mkdirSync(backups, { recursive: true });
			const backupDir = path.join(backups, `${from}-to-${to}-${stamp(now())}`);
			fs.mkdirSync(backupDir, { mode: 0o700 }); // not recursive: EEXIST errors with nothing changed
			backUp(dataDir, from, to, backupDir);
			checkpoint("after-backup");
			journal = { version: 1, from, to, fingerprint: fp, backupDir, done: [] };
			writeJournal(jfile, journal);
			checkpoint("after-journal");
		}

		// g. entities, one transaction each
		target = isSql(to) ? sqlTarget(dataDir, to, snap, locks.take(storeFile(dataDir, to)), journal.backupDir) : fileTarget(dataDir, rendered);
		for (const entity of ENTITIES) {
			if (journal.done.includes(entity)) continue;
			target.write(entity);
			checkpoint(`commit:${entity}`); // committed, journal not yet updated: a rerun redoes it, idempotently
			journal.done.push(entity);
			writeJournal(jfile, journal);
			checkpoint(`after:${entity}`);
		}

		// h. close the writable handle, then read the target back read-only
		target.close();
		target = undefined;
		checkpoint("before-verify");
		const diff = isSql(to) ? sqlDifference(storeFile(dataDir, to), to, snap) : fileDifference(dataDir, rendered);
		if (diff !== undefined) {
			fs.rmSync(jfile, { force: true }); // this target is wrong: the next run starts over from a fresh backup instead of trusting it
			throw new Error(MIGRATE_TEXT.verifyFailed(diff));
		}
		checkpoint("after-verify");

		// i. journal removed, then the marker: literally the last write
		fs.rmSync(jfile, { force: true });
		checkpoint("after-journal-removed");
		writeFileAtomicSync(mfile, `${JSON.stringify({ backend: to, layout: CURRENT_LAYOUT }, null, "\t")}\n`, { allowInPlaceFallback: true });
		checkpoint("after-marker");
		return { from, to, resumed, backupDir: journal.backupDir, counts: countsOf(snap), dropped: snap.dropped };
	} finally {
		target?.close();
		locks.releaseAll();
	}
}
