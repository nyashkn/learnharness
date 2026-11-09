/**
 * The sqlite backend for ONE data folder: `<dataDir>/graph.sqlite`, opened lazily (architecture 3, 7).
 *
 * OPEN NEVER WRITES (marker.ts header, golden fixtures), so nothing here creates the file on a read:
 *  - No `graph.sqlite` yet: reads are served by an in-memory store (`:memory:`, same driver, same rungs, same code).
 *  - The file exists: it is opened EAGERLY when the stores are built, so a newer store is refused at open (ADR 0009),
 *    and every later call uses the real store. An existing file below the top rung is an upgrade, which writes:
 *    `beforeWrite` (the store lock) first, and a `graph.bak-v<from>-<ts>.sqlite` copy (R5). A plain open at the top rung takes no lock.
 *  - Every outermost write calls `beforeWrite(dataDir)` first (lock, then create+migrate for a first sqlite write, then the marker).
 *    A write nested inside a transact does not: the transact itself was the write.
 * Handles live on globalThis, keyed by absolute file path, because Next dev loads several module instances in one process.
 */
import fs from "node:fs";
import path from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import type { Position } from "../../core/contracts.ts";
import type { GraphStore, SourceOrganizationStore } from "../../core/ports.ts";
import type { SqlDriver } from "./driver";
import { openNodeSqlite } from "./drivers/node-sqlite";
import { openGraphStore, type OpenedGraph } from "./graph-store";
import { migrate, needsMigration } from "./migrate";
import { graphMigration, graphRungs } from "./migrations/graph/index";
import { createSourceOrganizationStore } from "./source-organization-store";

export const GRAPH_DB_NAME = "graph.sqlite";
export const graphDbFile = (dataDir: string): string => path.join(path.resolve(dataDir), GRAPH_DB_NAME);

/** R5: `graph.bak-v<from>-<ts>.sqlite` beside the store. */
const backupPathIn = (dataDir: string) => (from: number): string =>
	path.join(path.resolve(dataDir), `graph.bak-v${from}-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);

/**
 * Create `graph.sqlite` and bring it to the top rung. Idempotent. A failure leaves no half-made file behind
 * (an empty graph.sqlite with no marker would make the next start read the folder as `file`).
 */
export function ensureGraphDb(dataDir: string, migration = graphMigration): void { // `migration` is for tests (a failing rung); the app never passes it
	const file = graphDbFile(dataDir);
	const existed = fs.existsSync(file);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = openNodeSqlite(file);
	try {
		migrate(db, { ...migration, lhVersion: pkg.version, backupPath: backupPathIn(dataDir) });
	} catch (error) {
		db.close();
		if (!existed) for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
		throw error;
	}
	db.close();
}

// ─── open handles: one per file per process, shared by every module instance ─────

interface Handle {
	db: SqlDriver;
	opened: OpenedGraph;
}
const HANDLES_KEY = "__lhSqlGraphHandles";
function handles(): Map<string, Handle> {
	const g = globalThis as unknown as Record<string, Map<string, Handle> | undefined>;
	return (g[HANDLES_KEY] ??= new Map());
}

/** Close this process's handle on a folder's graph.sqlite (tests, scripts). A later call reopens it. */
export function releaseGraphDb(dataDir: string): void {
	const file = graphDbFile(dataDir);
	handles().get(file)?.db.close();
	handles().delete(file);
}

export interface SqlGraphStores {
	graphStore: GraphStore;
	sourceOrganizationStore: SourceOrganizationStore;
}

/**
 * The sqlite GraphStore and SourceOrganizationStore for `dataDir`. Positions go to the file `positions` delegate
 * (a file-family concern that stays outside the transaction). `beforeWrite` is marker.ts's, passed in so this
 * file never imports the marker (which imports this file for the first-write create).
 */
export function createSqlGraphStores(
	dataDir: string,
	positions: Pick<GraphStore, "readPositions" | "writePositions">,
	emit: (event: "sources-changed", payload: Record<string, never>) => void,
	beforeWrite: (dataDir: string) => void,
): SqlGraphStores {
	const abs = path.resolve(dataDir);
	const file = graphDbFile(abs);
	const delegate = { read: (): Record<string, Position> => positions.readPositions(), write: (p: Record<string, Position>): void => positions.writePositions(p) };

	function openReal(): OpenedGraph {
		const known = handles().get(file);
		if (known) return known.opened;
		const db = openNodeSqlite(file);
		try {
			if (needsMigration(db, graphRungs)) beforeWrite(abs); // an upgrade writes: lock first. A newer or malformed store is not "needs", so it is refused below without a lock.
			const opened = openGraphStore({ db, file, lhVersion: pkg.version, positions: delegate, backupPath: backupPathIn(abs) });
			handles().set(file, { db, opened });
			return opened;
		} catch (error) {
			db.close();
			throw error;
		}
	}

	let memory: OpenedGraph | undefined;
	const real = (): OpenedGraph | undefined => handles().get(file)?.opened ?? (fs.existsSync(file) ? openReal() : undefined); // shortcut: one existsSync per call until the file appears; cache the answer if reads get hot
	const current = (): OpenedGraph => real() ?? (memory ??= openGraphStore({ db: openNodeSqlite(":memory:"), file, lhVersion: pkg.version, positions: delegate }));

	let so: { for: OpenedGraph; store: SourceOrganizationStore } | undefined;
	const orgStore = (): SourceOrganizationStore => {
		const o = current();
		if (so?.for !== o) so = { for: o, store: createSourceOrganizationStore({ core: o.core, emit }) };
		return so.store;
	};

	// A write nested inside an outer one (a transact body) is not a new write: the outer call already took beforeWrite.
	let depth = 0;
	function write<T>(fn: (o: OpenedGraph) => T): T {
		if (depth === 0) beforeWrite(abs);
		const o = real();
		if (!o) throw new Error(`${file} is missing after the first write took the lock: the marker names ${path.basename(file)} but it was not created`);
		depth++;
		try {
			return fn(o);
		} finally {
			depth--;
		}
	}
	const writeOrg = <T>(fn: (s: SourceOrganizationStore) => T): T => write(() => fn(orgStore()));
	// shortcut: transact counts as a write on entry, so a read-only transact on an empty folder writes the marker, lock and database. Upgrade to
	// taking beforeWrite on the first write inside the transaction (GraphCore.changed) when a read-only transact on a fresh folder matters.

	const graphStore: GraphStore & { corruptLines(): number } = {
		corruptLines: () => current().store.corruptLines(),
		appendNode: (n) => write((o) => o.store.appendNode(n)),
		readNodes: () => current().store.readNodes(),
		appendChain: (c) => write((o) => o.store.appendChain(c)),
		readChains: () => current().store.readChains(),
		appendCheckpoint: (c) => write((o) => o.store.appendCheckpoint(c)),
		readCheckpoints: () => current().store.readCheckpoints(),
		appendCoverage: (e) => write((o) => o.store.appendCoverage(e)),
		readCoverage: () => current().store.readCoverage(),
		upsertSource: (s) => write((o) => o.store.upsertSource(s)),
		readSources: () => current().store.readSources(),
		deleteSources: (ids) => write((o) => o.store.deleteSources(ids)),
		appendSourceUsage: (id, e) => write((o) => o.store.appendSourceUsage(id, e)),
		readPositions: () => positions.readPositions(),
		writePositions: (p) => positions.writePositions(p), // the file store's own write takes beforeWrite
		rewriteLedgers: (next) => write((o) => o.store.rewriteLedgers(next)),
		transact: (label, fn) => write((o) => o.store.transact(label, fn)),
		revision: () => current().store.revision(),
	};
	const sourceOrganizationStore: SourceOrganizationStore = {
		read: () => orgStore().read(),
		write: (state) => writeOrg((s) => s.write(state)),
	};

	if (fs.existsSync(file)) openReal(); // eager: a newer store is refused at open, an older one upgraded now
	return { graphStore, sourceOrganizationStore };
}
