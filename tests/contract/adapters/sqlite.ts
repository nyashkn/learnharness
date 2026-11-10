/**
 * SQLite adapter: src/store/sql/graph-store.ts over node:sqlite, in <dir>/graph.sqlite. Built on the file
 * adapter: chats, jobs, settings, prompts, auth and render settings stay the file ones; positions go to the file
 * helper (the store's positions delegate). Every driver is tracked per folder so dispose closes them all
 * (reopen does not dispose the earlier bundle).
 */
import * as path from "node:path";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../../../src/core/contracts/graph.ts";
import { emit, subscribe } from "../../../src/core/events.ts";
import { createSourceOrganizationStore } from "../../../src/store/sql/source-organization-store.ts";
import { openGraphStore } from "../../../src/store/sql/graph-store.ts";
import type { SqlDriver } from "../../../src/store/sql/driver.ts";
import { openNodeSqlite } from "../../../src/store/sql/drivers/node-sqlite.ts";
import type { AdapterFactory, AnyLedger, StoreBundle } from "../harness.ts";
import fileFactory from "./file.ts";

const TABLES: Record<AnyLedger, string> = { nodes: "ledger_nodes", chains: "ledger_chains", coverage: "ledger_coverage", checkpoints: "ledger_checkpoints", reviews: "ledger_reviews", reviewRemaps: "ledger_review_remaps" };
const driversByDir = new Map<string, SqlDriver[]>();

const factory: AdapterFactory = {
	name: "sqlite",
	capabilities: { revision: true, corruptLines: true, refusesAtOpen: true, commits: false },
	async open(dir): Promise<StoreBundle> {
		const base = await fileFactory.open(dir);
		const db = openNodeSqlite(path.join(dir, "graph.sqlite"));
		db.exec("PRAGMA synchronous = OFF"); // shortcut: the suite does thousands of autocommits; power-loss durability is the driver's own test, not the contract's
		driversByDir.set(dir, [...(driversByDir.get(dir) ?? []), db]);
		const closeAll = () => { for (const d of driversByDir.get(dir) ?? []) d.close(); };
		let opened;
		try {
			opened = openGraphStore({ db, file: "graph.sqlite", lhVersion: "test", positions: { read: base.graph.readPositions, write: base.graph.writePositions } });
		} catch (error) {
			closeAll();
			throw error;
		}
		const setLineFormat = (v: number) => db.run("UPDATE lh_meta SET value = ? WHERE key = 'line_format'", String(v));
		return {
			...base,
			graph: opened.store,
			sourceOrg: createSourceOrganizationStore({ core: opened.core, emit }),
			events: { subscribe: (l) => { const a = base.events.subscribe(l); const b = subscribe(l); return () => { a(); b(); }; } },
			hooks: {
				injectCorruptLine: (ledger, text) => { db.run(`INSERT INTO ${TABLES[ledger]} (line_json) VALUES (?)`, text); },
				stampNewerFormat: () => { base.hooks.stampNewerFormat(); setLineFormat(CURRENT_GRAPH_FORMAT_VERSION + 1); },
				clearFormatStamp: () => { base.hooks.clearFormatStamp(); setLineFormat(CURRENT_GRAPH_FORMAT_VERSION); },
			},
			dispose: () => { try { base.dispose(); } finally { closeAll(); } },
		};
	},
};
export default factory;
