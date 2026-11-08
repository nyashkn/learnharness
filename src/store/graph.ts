/**
 * GraphStore — the fs JSONL adapter: the append-only ledgers at
 * config.LEDGER_FILES (contracts.ts "v1 emission").
 *   nodes.jsonl     GraphNode        — one line per node write: the FIRST
 *                                      line for an id defines it; a later
 *                                      line with a REPEATED id is a
 *                                      link-append (session phrasings join
 *                                      aliases, provenance unions); reads
 *                                      merge by id (core/graph.ts getGraph)
 *   chains.jsonl    GraphChain       — one line per chain ASSERTION (a second
 *                                      session asserting the same
 *                                      (premises, conclusion) appends
 *                                      another line; readers merge)
 *   sessions.jsonl  SessionCheckpoint— emission checkpoints (foldedAt)
 *   coverage.jsonl  CoverageEntry    — per-message extraction coverage
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): there is NO edges ledger — the edge
 * view (implication nodes + untyped arrows) is derived in core/graph.ts on
 * every read and never persisted. A stale edges.jsonl left by a pre-chains
 * build is deleted once, here, at adapter load (same doctrine as the
 * events-ledger purge below).
 *
 * Plus config.SOURCES_FILE (sources.json): the imported-notes bookkeeping
 * (NOT a ledger) — one JSON map, src-id → NotesSource, read-modify-write
 * like a chat file. The format-agnostic front door (2026-09-13).
 *
 * Implements core/ports.ts GraphStore. data/graph/* is exclusively this
 * adapter's. Reads are strict against the contracts.ts shapes (the 2026-09-02
 * graph redesign): corrupt lines are skipped, never guessed at — the ledgers
 * are the source of truth and everything else is derived (core/graph.ts,
 * which takes this port as a parameter). Same idioms as src/store/chats.ts:
 * sync fs, no framework.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { beforeWrite } from "./marker.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";
import type {
	GraphChain,
	GraphNode,
	ExtractionRunUsage,
	NotesSource,
	Position,
	ProvenancePoint,
	CoverageEntry,
	SessionCheckpoint,
} from "../core/contracts.ts";
import type { GraphStore } from "../core/ports.ts";

// ─── JSONL primitives ────────────────────────────────────────────────────────

// ─── transact: the in-memory op log ─────────────────────────────────────────
// Inside graphStore.transact the write methods push ops here instead of
// touching disk; reads replay the log over what disk holds (read-your-writes);
// success flushes the ops in CALL ORDER. No crash atomicity across files —
// only the SQL adapters get that (architecture CB2 note).

type Op =
	| { t: "append"; file: string; record: unknown }
	| { t: "rewrite"; file: string; records: unknown[] }
	| { t: "sources"; map: Record<string, NotesSource>; deleting: boolean }
	| { t: "deferred"; key: string; value: unknown; flush: () => void; after?: () => void };
interface Txn { ops: Op[]; poisoned: boolean }

/** The file names inside one graph dir (the same names config.ts publishes for the singleton). */
export function graphPaths(graphDir: string) {
	return {
		nodes: path.join(graphDir, "nodes.jsonl"),
		chains: path.join(graphDir, "chains.jsonl"),
		sessions: path.join(graphDir, "sessions.jsonl"),
		coverage: path.join(graphDir, "coverage.jsonl"),
		sources: path.join(graphDir, "sources.json"),
		positions: path.join(graphDir, "positions.json"),
		format: path.join(graphDir, "format.json"),
	} as const;
}

/** Everything one store instance owns: its paths and its transact state. Nothing is module-level. */
interface Ctx {
	txn: Txn | null;
	/** The data folder the marker and lock live in. */
	dataDir: string;
	files: ReturnType<typeof graphPaths>;
}

/** What the record will look like once it has been through disk. */
const viaDisk = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A sibling adapter's write (source organization) that must commit or roll
 *  back with the open transaction. True = deferred to commit (the caller does
 *  nothing more); false = no transaction is open, so write now. `flush` runs
 *  at commit, in call order, and does the write only; `after` (events) runs
 *  once every op has flushed, so a listener sees the whole committed state
 *  and a failed flush emits nothing. */
function deferWrite(c: Ctx, key: string, value: unknown, flush: () => void, after?: () => void): boolean {
	if (!c.txn) return false;
	c.txn.ops.push({ t: "deferred", key, value: viaDisk(value), flush, after });
	return true;
}

/** The newest pending value for `key` in the open transaction, or undefined. */
function pendingWrite(c: Ctx, key: string): unknown {
	if (!c.txn) return undefined;
	for (let i = c.txn.ops.length - 1; i >= 0; i--) {
		const op = c.txn.ops[i]!;
		if (op.t === "deferred" && op.key === key) return viaDisk(op.value);
	}
	return undefined;
}

function isThenable(v: unknown): boolean {
	return typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";
}

function transact<T>(c: Ctx, label: string, fn: () => T): T {
	const guarded = (): T => {
		const result = fn();
		if (isThenable(result)) {
			(result as unknown as PromiseLike<unknown>).then(undefined, () => {}); // no unhandled rejection from the discarded work
			throw new TypeError(`GraphStore.transact("${label}"): fn must be synchronous; a returned promise cannot be rolled back`);
		}
		return result;
	};
	if (c.txn) { // nested: join the outer; a throw poisons it even if the caller catches
		try {
			return guarded();
		} catch (err) {
			c.txn.poisoned = true;
			throw err;
		}
	}
	const mine: Txn = { ops: [], poisoned: false };
	c.txn = mine;
	let result: T;
	try {
		result = guarded();
		if (mine.poisoned) throw new Error(`GraphStore.transact("${label}"): a nested transact threw, so this one rolls back`);
	} finally {
		c.txn = null; // the flush below writes straight to disk
	}
	for (const op of mine.ops) {
		if (op.t === "append") appendLine(c, op.file, op.record);
		else if (op.t === "rewrite") rewriteFile(c, op.file, op.records);
		else if (op.t === "deferred") op.flush();
		else if (op.deleting) deleteSourceMap(c, op.map);
		else writeSourceMap(c, op.map);
	}
	for (const op of mine.ops) if (op.t === "deferred") op.after?.();
	return result;
}

/** True when `file` is absent, empty or ends in a newline. */
function endsClean(file: string): boolean {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return true;
	}
	try {
		const size = fs.fstatSync(fd).size;
		if (size === 0) return true;
		const last = Buffer.alloc(1);
		fs.readSync(fd, last, 0, 1, size - 1);
		return last[0] === 0x0a;
	} finally {
		fs.closeSync(fd);
	}
}

function appendLine<T>(c: Ctx, file: string, record: T): void {
	assertGraphFormat(c.files.format); // a newer-stamped dir refuses writes too, even inside a transact
	if (c.txn) {
		c.txn.ops.push({ t: "append", file, record: viaDisk(record) });
		return;
	}
	beforeWrite(c.dataDir); // marker + store lock on the first write, never at open
	fs.mkdirSync(path.dirname(file), { recursive: true });
	ensureGraphFormat(c.files.format); // the lazy format stamp (graph-format.ts)
	// A torn tail (crash mid-append) must stay its own corrupt line, not swallow this record.
	const prefix = endsClean(file) ? "" : "\n";
	stamped(c, file, () => fs.appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, "utf-8"));
}

// ─── revision: the fs IS the counter ────────────────────────────────────────

/** The newest mtime across the four ledgers and sources.json (0 if none exist).
 *  positions.json and render settings are deliberately outside it: contract N7
 *  keeps a rolled-back transact from moving it, and SQL revisions cannot see them. */
function revisionNow(c: Ctx): number {
	let revision = 0;
	for (const file of [c.files.nodes, c.files.chains, c.files.sessions, c.files.coverage, c.files.sources]) {
		try {
			revision = Math.max(revision, fs.statSync(file).mtimeMs);
		} catch {
			/* absent — nothing has ever written it */
		}
	}
	return revision;
}

/** Run a write to `file`, then make sure its mtime is strictly above the revision
 *  from before the write. Filesystems with coarse timestamps (~4 ms on Linux CI) or a
 *  future-dated file would otherwise let a real write leave the revision unchanged. */
function stamped(c: Ctx, file: string, write: () => void): void {
	const before = revisionNow(c);
	write();
	if (fs.statSync(file).mtimeMs > before) return;
	const next = new Date(Math.ceil(before) + 1);
	fs.utimesSync(file, next, next);
}

/** Content-identical to what is on disk (an absent file is never identical). */
function sameOnDisk(file: string, body: string): boolean {
	try {
		return fs.readFileSync(file, "utf-8") === body;
	} catch {
		return false;
	}
}

function readRawLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return []; // no ledger yet — nothing has ever been emitted
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// Corrupt line: skip rather than fail the whole read — a torn
			// append must never take the home graph down with it.
		}
	}
	return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Strict shape guards — anything not matching a W4 ledger shape is skipped. */
function readValid<T>(c: Ctx, file: string, isValid: (v: unknown) => v is T): T[] {
	assertGraphFormat(c.files.format); // honest refusal on a newer-stamped data dir
	let records = readRawLines(file);
	if (c.txn) {
		for (const op of c.txn.ops) {
			if (op.t === "append" && op.file === file) records.push(viaDisk(op.record));
			else if (op.t === "rewrite" && op.file === file) records = op.records.map(viaDisk);
		}
	}
	return records.filter(isValid);
}

/** Provenance points are (chatId, messageId) pairs — message-granular. */
const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isRecord(v) && isString(v.chatId) && isString(v.messageId);


const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

/** A chain line: premises ≥ 1 (a chain IS an argument — bare propositions
 *  ride the node ledger alone), every member a string, conclusion a string.
 *  Endpoint EXISTENCE is the derivation's concern (it drops dangling
 *  chains); the store only shapes. */
const isGraphChain = (v: unknown): v is GraphChain =>
	isRecord(v) &&
	isString(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isString) &&
	isString(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint) &&
	isString(v.createdAt);

const isCheckpoint = (v: unknown): v is SessionCheckpoint =>
	isRecord(v) && isString(v.chatId) && isString(v.foldedAt);

const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isRecord(v) && isString(v.chatId) && isString(v.fp) && typeof v.tokens === "number" && isString(v.foldedAt);

// ─── the port implementation ────────────────────────────────────────────────

function build(c: Ctx): GraphStore {
	return {
		appendNode(node: GraphNode): void {
			appendLine(c, c.files.nodes, node);
		},
		/** Raw node lines in append order. A node id may appear on more than
		 *  one line (a later session's LINK-append: phrasings + provenance); the
		 *  derivation (core/graph.ts getGraph) merges lines by id. */
		readNodes(): GraphNode[] {
			return readValid(c, c.files.nodes, isGraphNode);
		},

		/** Append one chain ASSERTION; readers merge lines by (premises,
		 *  conclusion). */
		appendChain(assertion: GraphChain): void {
			appendLine(c, c.files.chains, assertion);
		},
		readChains(): GraphChain[] {
			return readValid(c, c.files.chains, isGraphChain);
		},

		appendCheckpoint(checkpoint: SessionCheckpoint): void {
			appendLine(c, c.files.sessions, checkpoint);
		},
		readCheckpoints(): SessionCheckpoint[] {
			return readValid(c, c.files.sessions, isCheckpoint);
		},

		appendCoverage(entry: CoverageEntry): void {
			appendLine(c, c.files.coverage, entry);
		},
		readCoverage(): CoverageEntry[] {
			return readValid(c, c.files.coverage, isCoverageEntry);
		},

		// ── imported-notes bookkeeping (config.SOURCES_FILE — a JSON map) ──

		/** Upsert: keeps the existing record's usage log when re-importing. */
		upsertSource(source: NotesSource): void {
			transact(c, "auto:upsertSource", () => {
				const all = readSourceMap(c);
				const prev = all[source.id];
				all[source.id] = prev ? { ...source, extractions: prev.extractions } : source;
				writeSourceMap(c, all);
			});
		},
		readSources(): NotesSource[] {
			return Object.values(readSourceMap(c));
		},
		deleteSources(ids: ReadonlySet<string>): number {
			if (ids.size === 0) return 0;
			return transact(c, "auto:deleteSources", () => {
				const all = readSourceMap(c);
				let removed = 0;
				for (const id of ids) if (Object.hasOwn(all, id)) { delete all[id]; removed++; }
				if (removed === 0) return 0;
				writeSourceMap(c, all, true);
				return removed;
			});
		},
		/** Idempotent per startedAt — same discipline as chats.appendExtractionUsage. */
		appendSourceUsage(id: string, entry: ExtractionRunUsage): void {
			transact(c, "auto:appendSourceUsage", () => {
				const all = readSourceMap(c);
				const source = all[id];
				if (!source) return; // no such source — nothing to bill against
				source.extractions = source.extractions?.some((r) => r.startedAt === entry.startedAt)
					? source.extractions
					: [...(source.extractions ?? []), entry];
				writeSourceMap(c, all);
			});
		},

		// ── the layout ledger (config.POSITIONS_FILE — a JSON map) ──
		readPositions(): Record<string, Position> {
			return readPositionMap(c);
		},
		writePositions(positions: Record<string, Position>): void {
			writePositionMap(c, positions);
		},

		/** THE DESTRUCTIVE SEAM (wave 6 session deletion): atomic full-content
		 *  replacement per provided ledger (atomic-write.ts: crashes mid-write
		 *  leave the original ledger and orphan .tmp-* files, never torn
		 *  ledger). Empty arrays write an empty file — a purged ledger reads
		 *  as "nothing yet", same as never-emitted. */
		rewriteLedgers(next: {
			nodes?: GraphNode[];
			chains?: GraphChain[];
			coverage?: CoverageEntry[];
			checkpoints?: SessionCheckpoint[];
		}): void {
			const files = {
				nodes: c.files.nodes,
				chains: c.files.chains,
				coverage: c.files.coverage,
				checkpoints: c.files.sessions,
			} as const;
			assertGraphFormat(c.files.format);
			for (const [key, records] of Object.entries(next) as [keyof typeof files, unknown[]][]) {
				if (c.txn) c.txn.ops.push({ t: "rewrite", file: files[key], records: records.map(viaDisk) });
				else rewriteFile(c, files[key], records);
			}
		},

		transact: <T>(label: string, fn: () => T) => transact(c, label, fn),
		revision: () => revisionNow(c),
	};
}

/** JSONL: one record per line, trailing newline — the reader must see
 *  exactly what appendLine would have written. */
function rewriteFile(c: Ctx, file: string, records: unknown[]): void {
	beforeWrite(c.dataDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
	if (!sameOnDisk(file, body)) stamped(c, file, () => writeFileAtomicSync(file, body)); // a no-op rewrite must not move the revision
	removeLeftoverTemps(file); // crash leftovers would still hold the purged records
}

function deleteSourceMap(c: Ctx, map: Record<string, NotesSource>): void {
	assertGraphFormat(c.files.format);
	beforeWrite(c.dataDir);
	const body = JSON.stringify(map, null, "\t");
	if (!sameOnDisk(c.files.sources, body)) stamped(c, c.files.sources, () => writeFileAtomicSync(c.files.sources, body));
	removeLeftoverTemps(c.files.sources); // crash leftovers would still hold the deleted sources
}

/** positions.json — { positions, updatedAt }. Read-modify-write, NOT
 *  append-only: the settle is a full-graph computation, so it replaces the
 *  whole map. The updatedAt stamp exists for future live-physics conflict
 *  handling (a browser commit must be able to detect "the graph changed
 *  underneath me"); reads just return the map. */
function readPositionMap(c: Ctx): Record<string, Position> {
	let raw: string;
	try {
		raw = fs.readFileSync(c.files.positions, "utf-8");
	} catch {
		return {}; // no ledger yet — nothing has ever settled
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || !isRecord(parsed.positions)) return {};
		const out: Record<string, Position> = {};
		for (const [id, value] of Object.entries(parsed.positions)) {
			if (isPosition(value)) out[id] = { x: value.x, y: value.y };
		}
		return out;
	} catch {
		return {};
	}
}

function writePositionMap(c: Ctx, positions: Record<string, Position>): void {
	beforeWrite(c.dataDir);
	fs.mkdirSync(path.dirname(c.files.positions), { recursive: true });
	writeFileAtomicSync(c.files.positions, JSON.stringify({ positions, updatedAt: new Date().toISOString() }, null, "\t"));
}

const isPosition = (v: unknown): v is Position =>
	isRecord(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);

/** sources.json — { id: NotesSource }. Read-modify-write, NOT append-only:
 *  the usage log lives inside the record (like a chat's JSON file). */
function readSourceMap(c: Ctx): Record<string, NotesSource> {
	assertGraphFormat(c.files.format); // honest refusal on a newer-stamped data dir
	if (c.txn) {
		for (let i = c.txn.ops.length - 1; i >= 0; i--) {
			const op = c.txn.ops[i]!;
			if (op.t === "sources") return viaDisk(op.map);
		}
	}
	let raw: string;
	try {
		raw = fs.readFileSync(c.files.sources, "utf-8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return {};
		const out: Record<string, NotesSource> = {};
		for (const [id, value] of Object.entries(parsed)) {
			if (isNotesSource(value)) out[id] = value;
		}
		return out;
	} catch {
		return {};
	}
}

function writeSourceMap(c: Ctx, map: Record<string, NotesSource>, deleting = false): void {
	assertGraphFormat(c.files.format);
	if (c.txn) {
		c.txn.ops.push({ t: "sources", map: viaDisk(map), deleting });
		return;
	}
	if (deleting) return deleteSourceMap(c, map);
	beforeWrite(c.dataDir);
	fs.mkdirSync(path.dirname(c.files.sources), { recursive: true });
	ensureGraphFormat(c.files.format); // the lazy format stamp (graph-format.ts)
	const body = JSON.stringify(map, null, "\t");
	if (sameOnDisk(c.files.sources, body)) return; // a no-op write must not move the revision
	stamped(c, c.files.sources, () => writeFileAtomicSync(c.files.sources, body, { allowInPlaceFallback: true }));
}

// ─── one-way purges when an instance is made: dead ledgers are exactly the confusion
// the cleanup removes (owner doctrine — nothing reads them, nothing writes
// them, a stale file lying around is a lie). ────────────────────────────────
function purgeLegacyLedgers(graphDir: string): void {
	for (const legacy of ["edges.jsonl", "events.jsonl"]) {
		const file = path.join(graphDir, legacy);
		try {
			if (fs.existsSync(file)) {
				fs.rmSync(file);
				console.info(`[graph-store] purged legacy ledger: ${file}`);
			}
		} catch (err) {
			console.warn(`[graph-store] could not purge legacy ledger ${file}:`, err);
		}
	}
}

const isNotesSource = (v: unknown): v is NotesSource =>
	isRecord(v) && isString(v.id) && isString(v.filePath) && isString(v.importedAt);

/** What a source-organization store needs to join this store's transact (module-private; see hooksOf). */
export interface GraphTxnHooks {
	deferWrite(key: string, value: unknown, flush: () => void, after?: () => void): boolean;
	pendingWrite(key: string): unknown;
}
const hooks = new WeakMap<GraphStore, GraphTxnHooks>();
/** The transact hooks of a store made by createGraphStore; undefined for any other GraphStore. */
export const txnHooksOf = (store: GraphStore): GraphTxnHooks | undefined => hooks.get(store);

/**
 * A file GraphStore over `graphDir`. Paths and transact state are per instance.
 * `dataDir` (default: the parent of graphDir) is where the marker and lock go.
 * Creating one does not touch disk except the one-way legacy-ledger purge.
 */
export function createGraphStore(graphDir: string, opts: { dataDir?: string } = {}): GraphStore {
	const c: Ctx = { txn: null, dataDir: opts.dataDir ?? path.dirname(path.resolve(graphDir)), files: graphPaths(graphDir) };
	purgeLegacyLedgers(graphDir);
	const store = build(c);
	hooks.set(store, { deferWrite: (k, v, f, a) => deferWrite(c, k, v, f, a), pendingWrite: (k) => pendingWrite(c, k) });
	return store;
}

/** The app's instance, built from config paths. src/server/stores.ts wires this same object. */
export const graphStore: GraphStore = createGraphStore(PATHS.graph, { dataDir: PATHS.data });
