/**
 * DoltLite adapters, two of them (the default export is an array):
 *  - `doltlite`: src/store/sql/graph-store.ts directly over openDoltlite(<dir>/graph.doltlite, { lock }), like the sqlite adapter.
 *    Runs wherever the addon loads.
 *  - `doltlite-app`: createFileStores with LH_STORAGE=doltlite, so marker.ts and sql/open.ts are what runs (the open, the promotion,
 *    the first-write order). Included on darwin-arm64 and linux-x64 only, because adapterFor refuses doltlite elsewhere.
 * Hooks that write go through a second connection and leave a dirty working set; that is fine, the next seal commits it.
 */
import { CURRENT_GRAPH_FORMAT_VERSION } from "../../../src/core/contracts/graph.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { emit, subscribe } from "../../../src/core/events.ts";
import { createFileStores } from "../../../src/store/file-stores.ts";
import { graphPaths } from "../../../src/store/graph.ts";
import { beforeWrite, releaseStoreLock } from "../../../src/store/marker.ts";
import type { SqlDriver } from "../../../src/store/sql/driver.ts";
import { openDoltlite } from "../../../src/store/sql/drivers/doltlite.ts";
import { openGraphStore } from "../../../src/store/sql/graph-store.ts";
import { acquireStoreLock, type StoreLock } from "../../../src/store/sql/lock.ts";
import { doltliteDbFile, releaseGraphDb } from "../../../src/store/sql/open.ts";
import { createSourceOrganizationStore } from "../../../src/store/sql/source-organization-store.ts";
import { chatHooks, type AdapterFactory, type AnyLedger, type StoreBundle } from "../harness.ts";
import fileFactory from "./file.ts";

const TABLES: Record<AnyLedger, string> = { nodes: "ledger_nodes", chains: "ledger_chains", coverage: "ledger_coverage", checkpoints: "ledger_checkpoints", reviews: "ledger_reviews", reviewRemaps: "ledger_review_remaps" };

/** One real store lock per folder: lock.ts refuses a live pid, our own included, so a reopen reuses the lock while it is held. */
const locksByDir = new Map<string, StoreLock>();
const lockFor = (dir: string): StoreLock => {
	const known = locksByDir.get(dir);
	if (known?.held()) return known;
	const lock = acquireStoreLock(doltliteDbFile(dir));
	locksByDir.set(dir, lock);
	return lock;
};
/** reopen does not dispose the earlier bundle; two live writable connections on one file are not what the app does, so a reopen closes the earlier driver first. */
const driversByDir = new Map<string, SqlDriver>();

/** FACT: the addon keeps its file descriptors (about 8 per store on the app path) until the statements that read the store are garbage collected AND the finalizers ran,
 *  and finalizers run on a later event-loop turn, which a property loop awaiting only promises never gives. V8 does not feel fd pressure either, so a suite making
 *  thousands of stores hits EMFILE (seen at the last test, J1). So: a full GC every 20 disposals, and the next open yields one macrotask. */
v8.setFlagsFromString("--expose-gc");
const collect = vm.runInNewContext("gc") as () => void;
let disposed = 0;
let yieldNext = false;
const afterDispose = (): void => { if (++disposed % 20 === 0) { collect(); yieldNext = true; } };
const letFinalizersRun = async (): Promise<void> => { if (yieldNext) { yieldNext = false; await new Promise<void>((r) => setImmediate(r)); } };
/** DoltLite fsyncs every commit, so the heavy properties (N1) need more than the 70 s the others get. */
const SLOW_MS = 300_000;

/** The commit messages of `<dir>/graph.doltlite`, newest first, through a read-only connection of their own ([] while the store does not exist yet). */
const commitMessagesOf = (dir: string): string[] => {
	const file = doltliteDbFile(dir);
	if (!fs.existsSync(file)) return [];
	const ro = openDoltlite(file, { readOnly: true });
	try { return ro.all<{ message: string }>("SELECT message FROM dolt_log").map((r) => r.message); } finally { ro.close(); }
};

const direct: AdapterFactory = {
	name: "doltlite",
	propertyTimeoutMs: SLOW_MS,
	capabilities: { revision: true, corruptLines: true, refusesAtOpen: true, commits: true },
	async open(dir): Promise<StoreBundle> {
		await letFinalizersRun();
		const base = await fileFactory.open(dir);
		const file = doltliteDbFile(dir);
		driversByDir.get(dir)?.close();
		const lock = lockFor(dir);
		const db = openDoltlite(file, { lock });
		driversByDir.set(dir, db);
		let opened;
		try {
			opened = openGraphStore({ db, file, lhVersion: "test", positions: { read: base.graph.readPositions, write: base.graph.writePositions } });
		} catch (error) {
			db.close();
			throw error;
		}
		/** A second connection: a hook is not a store write. */
		const withDb = (fn: (d: SqlDriver) => void) => {
			const d = openDoltlite(file, { lock });
			try { fn(d); } finally { d.close(); }
		};
		const setLineFormat = (v: number) => withDb((d) => d.run("UPDATE lh_meta SET value = ? WHERE key = 'line_format'", String(v)));
		return {
			...base,
			graph: opened.store,
			sourceOrg: createSourceOrganizationStore({ core: opened.core, emit }),
			events: { subscribe: (l) => { const a = base.events.subscribe(l); const b = subscribe(l); return () => { a(); b(); }; } },
			hooks: {
				...chatHooks(dir),
				injectCorruptLine: (ledger, text) => withDb((d) => d.run(`INSERT INTO ${TABLES[ledger]} (line_json) VALUES (?)`, text)),
				stampNewerFormat: () => { base.hooks.stampNewerFormat(); setLineFormat(CURRENT_GRAPH_FORMAT_VERSION + 1); },
				clearFormatStamp: () => { base.hooks.clearFormatStamp(); setLineFormat(CURRENT_GRAPH_FORMAT_VERSION); },
				commitMessages: () => commitMessagesOf(dir),
			},
			dispose: () => {
				try { base.dispose(); } finally {
					try { driversByDir.get(dir)?.close(); } finally {
						driversByDir.delete(dir);
						locksByDir.get(dir)?.release();
						locksByDir.delete(dir);
						afterDispose();
					}
				}
			},
		};
	},
};

/** LH_STORAGE only for the open: the other adapters share this process, and the open's decision is what later writes use. */
function openAsDoltlite(dir: string) {
	const old = process.env.LH_STORAGE;
	process.env.LH_STORAGE = "doltlite";
	try {
		return createFileStores(dir, path.join(dir, "auth.json"));
	} finally {
		if (old === undefined) delete process.env.LH_STORAGE;
		else process.env.LH_STORAGE = old;
	}
}

const app: AdapterFactory = {
	name: "doltlite-app",
	propertyTimeoutMs: SLOW_MS,
	capabilities: { revision: true, corruptLines: true, refusesAtOpen: true, commits: true },
	async open(dir): Promise<StoreBundle> {
		await letFinalizersRun();
		const s = openAsDoltlite(dir);
		const formatFile = graphPaths(path.join(dir, "graph")).format;
		/** A second connection, as a hook is not a store write. `beforeWrite` first: the file exists only after a first write, and it returns the store lock. */
		const withDb = (fn: (db: SqlDriver) => void) => {
			const lock = beforeWrite(dir);
			if (!lock) throw new Error("beforeWrite returned no store lock on doltlite");
			const db = openDoltlite(doltliteDbFile(dir), { lock });
			try { fn(db); } finally { db.close(); }
		};
		const setLineFormat = (v: number) => withDb((db) => db.run("UPDATE lh_meta SET value = ? WHERE key = 'line_format'", String(v)));
		return {
			graph: s.graphStore, chats: s.chatStore, jobs: s.jobStore, settings: s.settingsStore,
			sourceOrg: s.sourceOrganizationStore, prompts: s.promptOverrides, auth: s.authStore,
			render: { read: () => s.renderSettingsStore.readRenderSettings(), write: (raw) => s.renderSettingsStore.writeRenderSettings(raw) },
			events: { subscribe },
			hooks: {
				...chatHooks(dir),
				injectCorruptLine: (ledger, text) => withDb((db) => db.run(`INSERT INTO ${TABLES[ledger]} (line_json) VALUES (?)`, text)),
				stampNewerFormat: () => { setLineFormat(CURRENT_GRAPH_FORMAT_VERSION + 1); fs.mkdirSync(path.dirname(formatFile), { recursive: true }); fs.writeFileSync(formatFile, JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION + 1 })); },
				clearFormatStamp: () => { fs.rmSync(formatFile, { force: true }); setLineFormat(CURRENT_GRAPH_FORMAT_VERSION); },
				commitMessages: () => commitMessagesOf(dir),
			},
			dispose: () => { try { releaseGraphDb(dir); } finally { releaseStoreLock(dir); afterDispose(); } },
		};
	},
};

// A hardcoded literal, not derived from src.
export default ["darwin-arm64", "linux-x64"].includes(`${process.platform}-${process.arch}`) ? [direct, app] : [direct];
