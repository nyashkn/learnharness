/**
 * Storage migration tool (M1, bead lh-smv): `lh migrate --to <backend>` and `lh export` (ADR 0004, 0006, 0009).
 *
 * Moves a data folder's graph between file, sqlite and doltlite, and exports it as a plain file-backend
 * folder. High risk: it moves real user data, so every step is ordered to leave the source untouched.
 *
 * Normalisation (architecture 2.1 item 12): CRLF becomes LF, blank lines and a torn tail are dropped and counted,
 * nothing else changes. `export(import(export(x))) == export(x)` byte for byte.
 *
 * migrate order: refusals (no lock, no write) -> locks -> newer probes (read-only) -> snapshot -> journal check ->
 * backup -> one transaction per entity (journal updated after each) -> verify (target read back == source) ->
 * journal removed -> marker written LAST. A crash anywhere reruns: same source + direction resumes, anything else restarts.
 * The source is never written: a file source is only read, an SQL source is only opened read-only.
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
import { BACKENDS, CURRENT_LAYOUT, graphFormatFileIn, markerFile, readMarker, type Backend } from "./marker.ts";
import { openDoltlite } from "./sql/drivers/doltlite.ts";
import { openNodeSqlite } from "./sql/drivers/node-sqlite.ts";
import type { SqlDriver } from "./sql/driver.ts";
import { assertStoreNotNewer, openGraphStore, type GraphCore } from "./sql/graph-store.ts";
import { acquireStoreLock, type StoreLock } from "./sql/lock.ts";

// ─── text ────────────────────────────────────────────────────────────────────

/** Every user-facing string of the two commands, one place (the way PURGE_TEXT does it). */
export const MIGRATE_TEXT = {
	usage: "usage: lh migrate --to <file|sqlite|doltlite> [--data-dir <path>]",
	exportUsage: "usage: lh export [--out <dir>] [--data-dir <path>]",
	noDataDir: (dir: string) => `the data folder ${dir} does not exist`,
	doltliteTarget: "this build cannot open a DoltLite data folder yet, so migrating to it would leave the app unable to start; nothing was changed. DoltLite as a source (the exit path) works",
	sameBackend: (backend: string) => `the data folder already uses the ${backend} backend; nothing to migrate`,
	missingStore: (store: string, backend: string) => `the marker names ${backend} but ${store} is missing; restore it before migrating or exporting`,
	markerChanged: "the storage marker changed while taking the locks; nothing was changed, run again",
	badSources: (file: string, why: string) => `${file} ${why}; refusing, because the app would read it as empty and the sources would be lost`,
	badJson: (file: string) => `${file} is not valid JSON; refusing, so nothing is lost silently`,
	badFormat: (file: string, version: number) => `${file} has version ${version}; a format version must be a positive integer`,
	notAStore: (file: string) => `${file} is not a LearnHarness graph store (no lh_meta table)`,
	badMeta: (file: string, key: string, value: string | undefined) => `${file}: lh_meta.${key} is ${value === undefined ? "missing" : JSON.stringify(value)}`,
	unknownTable: (file: string, table: string) => `${file} has a table this build does not know (${table}); refusing, so a newer layout is not lost silently`,
	unknownDocument: (file: string, key: string) => `${file} has a documents row this build does not know (${key}); refusing, so it is not lost silently`,
	badRecord: (file: string, what: string, id: string) => `${file}: ${what} ${JSON.stringify(id)} holds invalid JSON; refusing`,
	outNotEmpty: (out: string) => `${out} already exists and is not empty; an export never overwrites`,
	verifyFailed: (path: string) => `verification failed: the target differs from the source at ${path}; the marker was NOT written, the source is untouched, and the backup is kept`,
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

function readOptional(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
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
		const n = normaliseLedger(readOptional(path.join(g, l.file)) ?? "");
		ledgers[l.entity] = n.lines;
		add(dropped, n);
	}
	const sourcesFile = path.join(g, "sources.json");
	const sourcesText = readOptional(sourcesFile);
	let sources: [string, unknown][] = [];
	if (sourcesText !== undefined) {
		const parsed = parseJson(sourcesFile, sourcesText);
		if (!isPlainObject(parsed) || !Value.Check(SourcesShape, parsed)) throw new MigrateRefusedError(MIGRATE_TEXT.badSources(sourcesFile, "is not a JSON object"));
		sources = Object.entries(parsed); // entries the app's guard would skip are kept: dropping them would lose data
	}
	const orgFile = path.join(g, "source-organization.json");
	const orgText = readOptional(orgFile);
	const organization = orgText === undefined ? undefined : { value: parseJson(orgFile, orgText) };
	// graph-format.ts stampedVersion: absent, corrupt or non-integer = v1
	const formatFile = path.join(g, "format.json");
	let lineFormat = 1;
	const formatText = readOptional(formatFile);
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
			const rows = db.all<{ line_json: string }>(`SELECT line_json FROM ${l.table} ORDER BY seq`).map((r) => String(r.line_json));
			const n = normaliseLedger(rows.length === 0 ? "" : `${rows.join("\n")}\n`); // the same normaliser, so the first export is already a fixed point
			ledgers[l.entity] = n.lines;
			add(dropped, n);
		}
		const sources = db.all<{ id: string; record_json: string }>("SELECT id, record_json FROM sources").map(({ id, record_json }): [string, unknown] => {
			try {
				return [id, JSON.parse(record_json)];
			} catch {
				throw new MigrateRefusedError(MIGRATE_TEXT.badRecord(file, "source", id));
			}
		});
		let organization: Snapshot["organization"];
		for (const { key, json } of db.all<{ key: string; json: string }>("SELECT key, json FROM documents")) {
			if (key !== ORG_KEY) throw new MigrateRefusedError(MIGRATE_TEXT.unknownDocument(file, key));
			try {
				organization = { value: JSON.parse(json) };
			} catch {
				throw new MigrateRefusedError(MIGRATE_TEXT.badRecord(file, "document", key));
			}
		}
		return { lineFormat: Number(format), ledgers, sources, organization, dropped };
	} finally {
		db.close();
	}
}

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

/** Refusals shared by both entry points, in order: no lock and no write yet. Returns the backend the marker names. */
function refusals(dataDir: string): Backend {
	requireDataDir(dataDir);
	const marker = readMarker(markerFile(dataDir)); // a newer layout or a corrupt marker throws
	assertGraphFormat(graphFormatFileIn(dataDir)); // every backend: render settings and positions stay files, and `file` is valid = not stamped newer
	const backend = marker?.backend ?? "file";
	if (isSql(backend) && !fs.existsSync(storeFile(dataDir, backend))) throw new MigrateRefusedError(MIGRATE_TEXT.missingStore(storeFile(dataDir, backend), backend));
	return backend;
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

const sameMarker = (a: ReturnType<typeof readMarker>, b: ReturnType<typeof readMarker>): boolean => JSON.stringify(a) === JSON.stringify(b);

// ─── export ──────────────────────────────────────────────────────────────────

export interface ExportOptions {
	/** Tests only: called at after-lock. */
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
	const backend = refusals(dataDir);
	const out = path.resolve(outIn ?? path.join(dataDir, `export-${stamp((options.now ?? (() => new Date()))())}`));
	const existing = fs.statSync(out, { throwIfNoEntry: false });
	if (existing && (!existing.isDirectory() || fs.readdirSync(out).length > 0)) throw new MigrateRefusedError(MIGRATE_TEXT.outNotEmpty(out));

	const mfile = markerFile(dataDir);
	const marker = readMarker(mfile);
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
	const text = readOptional(file);
	if (text === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return Value.Check(JournalSchema, value) ? (value as Journal) : undefined;
	} catch {
		return undefined; // a corrupt journal is a fresh run
	}
}
const writeJournal = (file: string, j: Journal): void => writeFileAtomicSync(file, `${JSON.stringify(j, null, "\t")}\n`, { allowInPlaceFallback: true });

export interface MigrateOptions {
	/** Tests only: called at after-lock, after-backup, after-journal, commit:<entity>, after:<entity>, before-verify, after-verify, after-journal-removed, after-marker. A throw is a crash. */
	checkpoint?: (name: string) => void;
	now?: () => Date;
	/** Test only. D3 adds the doltlite adapter, removes the refusal in migrateBackend and removes this option. The CLI never passes it. */
	allowDoltliteTarget?: boolean;
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

function fileTarget(dataDir: string, rendered: Map<string, string>): Target {
	const rel: Record<Entity, string> = {
		meta: "graph/format.json",
		nodes: "graph/nodes.jsonl",
		chains: "graph/chains.jsonl",
		coverage: "graph/coverage.jsonl",
		checkpoints: "graph/sessions.jsonl",
		sources: "graph/sources.json",
		organization: "graph/source-organization.json",
	};
	return {
		write(entity) {
			const file = path.join(dataDir, rel[entity]);
			const text = rendered.get(rel[entity]);
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

function firstDifference(a: Map<string, string>, b: Map<string, string>): string | undefined {
	for (const p of new Set([...a.keys(), ...b.keys()])) if (a.get(p) !== b.get(p)) return p;
	return undefined;
}

export function migrateBackend(dataDirIn: string, to: Backend, options: MigrateOptions = {}): MigrateReport {
	const dataDir = path.resolve(dataDirIn);
	const checkpoint = options.checkpoint ?? (() => {});
	const now = options.now ?? (() => new Date());

	// a. refusals: before any write or lock
	if (!(BACKENDS as readonly string[]).includes(to)) throw new MigrateRefusedError(MIGRATE_TEXT.usage);
	if (to === "doltlite" && options.allowDoltliteTarget !== true) throw new MigrateRefusedError(MIGRATE_TEXT.doltliteTarget);
	const from = refusals(dataDir);
	if (from === to) throw new MigrateRefusedError(MIGRATE_TEXT.sameBackend(from));
	const mfile = markerFile(dataDir);
	const marker = readMarker(mfile);

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

		// e. journal: same direction and same source resumes, anything else is a fresh run
		const jfile = journalFile(dataDir);
		const prior = readJournal(jfile);
		const resumed = prior !== undefined && prior.from === from && prior.to === to && prior.fingerprint === fp && fs.existsSync(prior.backupDir);
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
		const diff = firstDifference(rendered, renderExport(snapshotOf(dataDir, to)));
		if (diff !== undefined) throw new Error(MIGRATE_TEXT.verifyFailed(diff));
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
