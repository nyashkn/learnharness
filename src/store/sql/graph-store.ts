/**
 * GraphStore on a SqlDriver (architecture 2.1, 4.1, 6). Factory only: the driver, the positions
 * delegate and the logger arrive as parameters. No singleton, no config path, no store lock
 * (lock and backend selection are S5).
 *
 * Lines are stored verbatim in four ledger tables (seq = append order = fold order). One transaction
 * core (`GraphCore`) serves this store and the source-organization store on the same driver:
 *   BEGIN IMMEDIATE, rows, (revision changed) lh_meta.revision += 1, COMMIT, (rows changed) seal(label), events.
 * Only the outermost transact bumps, seals and emits; a nested one joins it.
 */
import { Type } from "typebox";
import { lineCheck } from "../line-check.ts";
import type { ReviewLine, ReviewRemap, CoverageEntry, GraphChain, GraphNode, NotesSource, Position, SessionCheckpoint, ExtractionRunUsage } from "../../core/contracts.ts";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../../core/contracts/graph.ts";
import { ChainLineSchema } from "../../core/contracts/schemas/chain-line.ts";
import { CheckpointLineSchema } from "../../core/contracts/schemas/checkpoint-line.ts";
import { CoverageLineSchema } from "../../core/contracts/schemas/coverage-line.ts";
import { applyReviewRemaps, assertNoRemapCycle } from "../../core/review-remap.ts";
import { ReviewLineSchema, ReviewRemapLineSchema } from "../../core/contracts/schemas/review-line.ts";
import { NodeLineSchema } from "../../core/contracts/schemas/node-line.ts";
import type { GraphStore } from "../../core/ports.ts";
import { StorageVersionError } from "../../core/contracts/storage.ts";
import type { SqlDriver } from "./driver";
import { migrate, type MigrateOptions } from "./migrate";
import { graphMigration, graphRungs } from "./migrations/graph/index";

// ─── the shared transaction core ─────────────────────────────────────────────

export interface GraphCore {
	readonly db: SqlDriver;
	/** Throws StorageVersionError when lh_meta says the store is newer than this build. Free inside a transaction. */
	guard(): void;
	/** Run `fn` joined to the open transaction, or in its own `auto:<method>` one. */
	bare<T>(label: string, fn: () => T): T;
	/** A write changed rows: the commit seals. `revision` (default true) also bumps lh_meta.revision. */
	changed(opts?: { revision?: boolean }): void;
	/** Run after COMMIT and seal, in call order. Dropped on rollback. */
	afterCommit(fn: () => void): void;
}

export interface OpenGraphOptions {
	db: SqlDriver;
	/** Store file name for StorageVersionError. */
	file: string;
	lhVersion: string;
	/** positions.json is a file-family concern: reads and writes go to this delegate. */
	positions: { read(): Record<string, Position>; write(positions: Record<string, Position>): void };
	log?: (message: string, error?: unknown) => void;
	backupPath?: MigrateOptions["backupPath"];
}

export type SqlGraphStore = GraphStore & {
	/** Rows across the four ledgers that fail parse or schema (item 2). Scans on every call. */
	corruptLines(): number;
};

export interface OpenedGraph {
	store: SqlGraphStore;
	core: GraphCore;
	storeId: string;
}

interface Txn {
	dirty: boolean;
	revision: boolean;
	after: (() => void)[];
}

const isThenable = (v: unknown): boolean => typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";

/** R3 / ADR 0009: throws before any write when a stored version is above what this build knows. */
export function assertNotNewer(db: SqlDriver, file: string): void {
	const rows = db.all<{ key: string; value: string }>("SELECT key, value FROM lh_meta WHERE key IN ('schema_version', 'line_format')");
	for (const { key, value } of rows) {
		const supported = key === "schema_version" ? graphRungs.length : CURRENT_GRAPH_FORMAT_VERSION;
		const found = Number(value);
		if (Number.isInteger(found) && found > supported) throw new StorageVersionError(file, found, supported);
	}
}

/** Refuse a newer store (StorageVersionError); a store with no lh_meta yet is not one. */
export function assertStoreNotNewer(db: SqlDriver, file: string): void {
	if (hasMeta(db)) assertNotNewer(db, file);
}

const hasMeta = (db: SqlDriver) => db.get("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = 'lh_meta'") !== undefined;

// ─── ledgers ─────────────────────────────────────────────────────────────────

const LEDGERS = {
	nodes: { table: "ledger_nodes", schema: NodeLineSchema },
	chains: { table: "ledger_chains", schema: ChainLineSchema },
	coverage: { table: "ledger_coverage", schema: CoverageLineSchema },
	checkpoints: { table: "ledger_checkpoints", schema: CheckpointLineSchema },
	reviews: { table: "ledger_reviews", schema: ReviewLineSchema },
	reviewRemaps: { table: "ledger_review_remaps", schema: ReviewRemapLineSchema },
} as const;
type LedgerKey = keyof typeof LEDGERS;
const LEDGER_KEYS = Object.keys(LEDGERS) as LedgerKey[];
/** The ledgers rewriteLedgers may replace: reviews are not among them (a deleted session keeps its review history). */
const REWRITABLE = LEDGER_KEYS.filter((k) => k !== "reviews" && k !== "reviewRemaps") as Exclude<LedgerKey, "reviews" | "reviewRemaps">[];

const NotesSourceSchema = Type.Object({ id: Type.String(), filePath: Type.String(), importedAt: Type.String() }, { additionalProperties: true });

interface Row { seq: number; line_json: string }

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

/** The canonical bytes of a stored row, or null when it does not parse. A row imported with other whitespace compares equal to its canonical copy. */
function canonical(text: string): string | null {
	const parsed = tryParse(text);
	return parsed.ok ? JSON.stringify(parsed.value) : null;
}

export function openGraphStore(opts: OpenGraphOptions): OpenedGraph {
	const { db, file, positions } = opts;
	const log = opts.log ?? ((message: string, error?: unknown) => console.error(`[sql-graph-store] ${message}`, error ?? ""));

	assertStoreNotNewer(db, file); // StorageVersionError, not S2's MigrationRefusedError (the contract needs the name)
	db.recover(); // after the refusal (an older build must not seal a newer build's leftovers), before migrate (they must not fold into its seal)
	const { storeId } = migrate(db, { ...graphMigration, lhVersion: opts.lhVersion, backupPath: opts.backupPath, log });

	let txn: Txn | null = null;
	let pendingSeal: string | null = null;

	const guard = () => {
		if (!txn) assertNotNewer(db, file);
	};

	/** Seal what a failed seal left in the working set, before the next BEGIN. Never blocks the write. */
	function sealPending(): void {
		if (pendingSeal === null) return;
		try {
			db.seal(pendingSeal);
			pendingSeal = null;
		} catch (error) {
			log(`seal "${pendingSeal}" failed again; keeping it for the next transaction`, error);
		}
	}

	function transact<T>(label: string, fn: () => T): T {
		const guarded = (): T => {
			const result = fn();
			if (isThenable(result)) {
				(result as unknown as PromiseLike<unknown>).then(undefined, () => {}); // no unhandled rejection from the discarded work
				throw new TypeError(`GraphStore.transact("${label}"): fn must be synchronous; a returned promise cannot be rolled back`);
			}
			return result;
		};
		if (txn) return db.transaction(guarded); // joins the outer; a throw dooms it in the driver
		assertNotNewer(db, file);
		sealPending();
		const mine: Txn = { dirty: false, revision: false, after: [] };
		txn = mine;
		let result: T;
		try {
			result = db.transaction(() => {
				const r = guarded();
				if (mine.revision) db.run("UPDATE lh_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'");
				return r;
			});
		} finally {
			txn = null;
		}
		if (mine.dirty) {
			try {
				db.seal(label);
				pendingSeal = null; // the seal commits the whole working set, earlier leftovers included
			} catch (error) {
				pendingSeal ??= `recovered: ${label}`;
				log(`seal "${label}" failed after COMMIT; will seal "${pendingSeal}" before the next transaction`, error);
			}
		}
		for (const run of mine.after) {
			try {
				run();
			} catch (error) {
				log("a listener threw after commit", error);
			}
		}
		return result;
	}

	const core: GraphCore = {
		db,
		guard,
		bare: (label, fn) => (txn ? db.transaction(fn) : transact(label, fn)), // nested, so a throw part-way dooms the outer even if the caller catches it
		changed(o) {
			if (!txn) throw new Error("GraphCore.changed outside a transaction");
			txn.dirty = true;
			if (o?.revision !== false) txn.revision = true;
		},
		afterCommit(fn) {
			if (!txn) throw new Error("GraphCore.afterCommit outside a transaction");
			txn.after.push(fn);
		},
	};

	// ── reads and the identity memory behind rewriteLedgers ──
	/** The seq of every object a read returned. Stale entries are allowed: rewrite verifies the seq still exists. */
	const seqOf: Record<LedgerKey, WeakMap<object, number>> = { nodes: new WeakMap(), chains: new WeakMap(), coverage: new WeakMap(), checkpoints: new WeakMap(), reviews: new WeakMap(), reviewRemaps: new WeakMap() };

	function readLedger<T>(key: LedgerKey): T[] {
		guard();
		const out: T[] = [];
		for (const row of db.all<Row>(`SELECT seq, line_json FROM ${LEDGERS[key].table} ORDER BY seq`)) {
			const parsed = tryParse(row.line_json);
			if (!parsed.ok || !lineCheck(LEDGERS[key].schema, parsed.value)) continue; // corrupt: skipped here, counted by corruptLines()
			seqOf[key].set(parsed.value as object, row.seq);
			out.push(parsed.value as T);
		}
		return out;
	}

	function append(key: LedgerKey, method: string, record: unknown): void {
		guard();
		core.bare(`auto:${method}`, () => {
			if (db.run(`INSERT INTO ${LEDGERS[key].table} (line_json) VALUES (?)`, JSON.stringify(record)).changes > 0) core.changed();
		});
	}

	/**
	 * Make the table hold exactly `kept`, in order, with the least row churn. Returns rows changed.
	 * Align each kept object to an unconsumed row (identity, then canonical bytes), then walk kept in order:
	 * aligned rows stay (UPDATE if the content differs), an unaligned object takes a free row in the gap before
	 * the next aligned one, and on a reorder or a missing gap that object and everything after it is
	 * re-inserted above the current max seq. Unused rows are deleted. A pure delete issues DELETEs only.
	 */
	function rewrite(key: LedgerKey, kept: readonly object[]): number {
		const table = LEDGERS[key].table;
		const rows = db.all<Row>(`SELECT seq, line_json FROM ${table} ORDER BY seq`);
		const canon = rows.map((r) => canonical(r.line_json));
		const text = kept.map((o) => JSON.stringify(o));
		const n = kept.length;
		if (rows.length === n && canon.every((c, i) => c === text[i])) {
			// Nothing to do: the stored lines already ARE kept, in order. Without this, equal duplicates handed back in a different
			// order (or copies of them) would align by identity into a "reorder" and delete + insert rows for no change, moving the revision.
			kept.forEach((o, i) => seqOf[key].set(o, rows[i]!.seq));
			return 0;
		}
		const rowAt = new Map(rows.map((r, i) => [r.seq, i]));
		const used = rows.map(() => false);
		const align: number[] = kept.map(() => -1);
		const alignedTo = (i: number): number => align[i] ?? -1;

		kept.forEach((obj, i) => {
			const seq = seqOf[key].get(obj);
			const ri = seq === undefined ? undefined : rowAt.get(seq);
			if (ri !== undefined && !used[ri]) { align[i] = ri; used[ri] = true; }
		});
		const byBytes = new Map<string, number[]>();
		canon.forEach((c, ri) => {
			if (c !== null && !used[ri]) (byBytes.get(c) ?? byBytes.set(c, []).get(c)!).push(ri); // ascending: equal duplicates take the lowest seq
		});
		for (let i = 0; i < n; i++) {
			if (alignedTo(i) >= 0) continue;
			const ri = byBytes.get(text[i]!)?.shift();
			if (ri !== undefined) { align[i] = ri; used[ri] = true; }
		}

		const nextAligned: number[] = new Array(n + 1).fill(Infinity);
		for (let i = n - 1; i >= 0; i--) nextAligned[i] = alignedTo(i) >= 0 ? rows[alignedTo(i)]!.seq : nextAligned[i + 1]!;

		const place = new Array<number>(n).fill(-1);
		let last = 0;
		let free = 0; // pointer over rows: first candidate for a gap
		let moveFrom = n;
		for (let i = 0; i < n; i++) {
			if (alignedTo(i) >= 0) {
				const seq = rows[alignedTo(i)]!.seq;
				if (seq <= last) { moveFrom = i; break; } // a reorder
				place[i] = alignedTo(i);
				last = seq;
				continue;
			}
			while (free < rows.length && (used[free] || rows[free]!.seq <= last)) free++;
			if (free < rows.length && rows[free]!.seq < nextAligned[i + 1]!) {
				used[free] = true;
				place[i] = free;
				last = rows[free]!.seq;
			} else { moveFrom = i; break; } // no free seq in the gap
		}

		const keep = new Set(place.slice(0, moveFrom));
		const maxSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : 0; // before the deletes
		let changes = 0;
		rows.forEach((r, ri) => {
			if (!keep.has(ri)) changes += db.run(`DELETE FROM ${table} WHERE seq = ?`, r.seq).changes;
		});
		for (let i = 0; i < moveFrom; i++) {
			const ri = place[i]!;
			if (canon[ri] !== text[i]) changes += db.run(`UPDATE ${table} SET line_json = ? WHERE seq = ?`, text[i]!, rows[ri]!.seq).changes;
			seqOf[key].set(kept[i]!, rows[ri]!.seq);
		}
		for (let i = moveFrom; i < n; i++) {
			const seq = maxSeq + 1 + (i - moveFrom);
			changes += db.run(`INSERT INTO ${table} (seq, line_json) VALUES (?, ?)`, seq, text[i]!).changes;
			seqOf[key].set(kept[i]!, seq);
		}
		return changes;
	}

	// ── sources map ──
	function sourceRow(id: string): { id: string; record_json: string } | undefined {
		return db.get("SELECT id, record_json FROM sources WHERE id = ?", id);
	}
	const parseSource = (json: string): NotesSource | undefined => {
		const parsed = tryParse(json);
		return parsed.ok && lineCheck(NotesSourceSchema, parsed.value) ? (parsed.value as NotesSource) : undefined;
	};
	const putSource = (id: string, record: unknown, prevCanonical: string | null): void => {
		const text = JSON.stringify(record);
		if (text === prevCanonical) return; // identical content is zero changes
		if (db.run("INSERT INTO sources (id, record_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json", id, text).changes > 0) core.changed();
	};

	const store = {
		appendNode: (node: GraphNode) => append("nodes", "appendNode", node),
		readNodes: () => readLedger<GraphNode>("nodes"),
		appendChain: (assertion: GraphChain) => append("chains", "appendChain", assertion),
		readChains: () => readLedger<GraphChain>("chains"),
		appendCheckpoint: (checkpoint: SessionCheckpoint) => append("checkpoints", "appendCheckpoint", checkpoint),
		readCheckpoints: () => readLedger<SessionCheckpoint>("checkpoints"),
		appendCoverage: (entry: CoverageEntry) => append("coverage", "appendCoverage", entry),
		readCoverage: () => readLedger<CoverageEntry>("coverage"),
		appendReview: (line: ReviewLine) => append("reviews", "appendReview", line),
		readReviews: () => applyReviewRemaps(readLedger<ReviewLine>("reviews"), readLedger<ReviewRemap>("reviewRemaps")),
		remapReviewTargets: (from: string, to: string) => {
			assertNoRemapCycle(readLedger<ReviewRemap>("reviewRemaps"), from, to); // before any write; readLedger guards; a refusal does not poison an enclosing transact
			append("reviewRemaps", "remapReviewTargets", { from, to });
		},

		upsertSource(source: NotesSource): void {
			guard();
			core.bare("auto:upsertSource", () => {
				const prevRow = sourceRow(source.id);
				const prev = prevRow ? parseSource(prevRow.record_json) : undefined;
				putSource(source.id, prev ? { ...source, extractions: prev.extractions } : source, prevRow ? canonical(prevRow.record_json) : null);
			});
		},
		readSources(): NotesSource[] {
			guard();
			return db.all<{ record_json: string }>("SELECT record_json FROM sources ORDER BY rowid").flatMap((r) => parseSource(r.record_json) ?? []);
		},
		deleteSources(ids: ReadonlySet<string>): number {
			if (ids.size === 0) return 0;
			guard();
			return core.bare("auto:deleteSources", () => {
				let removed = 0;
				for (const id of ids) removed += db.run("DELETE FROM sources WHERE id = ?", id).changes;
				if (removed > 0) core.changed();
				return removed;
			});
		},
		appendSourceUsage(id: string, entry: ExtractionRunUsage): void {
			guard();
			core.bare("auto:appendSourceUsage", () => {
				const prevRow = sourceRow(id);
				const source = prevRow ? parseSource(prevRow.record_json) : undefined;
				if (!prevRow || !source) return; // no such source: nothing to bill against
				if (source.extractions?.some((r) => r.startedAt === entry.startedAt)) return;
				putSource(id, { ...source, extractions: [...(source.extractions ?? []), entry] }, canonical(prevRow.record_json));
			});
		},

		readPositions: () => positions.read(),
		writePositions: (p: Record<string, Position>) => positions.write(p),

		rewriteLedgers(next): void {
			guard();
			core.bare("auto:rewriteLedgers", () => {
				let changes = 0;
				for (const key of REWRITABLE) {
					const kept = next[key];
					if (kept !== undefined) changes += rewrite(key, kept);
				}
				if (changes > 0) core.changed();
			});
		},

		transact,
		revision(): number {
			guard();
			return Number(db.get<{ value: string }>("SELECT value FROM lh_meta WHERE key = 'revision'")?.value ?? 0);
		},

		corruptLines(): number {
			guard();
			let bad = 0;
			for (const key of LEDGER_KEYS) {
				for (const row of db.all<Row>(`SELECT seq, line_json FROM ${LEDGERS[key].table}`)) {
					const parsed = tryParse(row.line_json);
					if (!parsed.ok || !lineCheck(LEDGERS[key].schema, parsed.value)) bad++;
				}
			}
			return bad;
		},
	} satisfies SqlGraphStore;

	return { store, core, storeId };
}
