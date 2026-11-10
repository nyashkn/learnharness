/**
 * The app's sqlite path: createFileStores on an empty folder with LH_STORAGE=sqlite, so marker.ts and sql/open.ts
 * are what runs (the `sqlite` adapter calls openGraphStore directly and skips both). Reads before the first write come
 * from the in-memory store, as they do in the app.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../../../src/core/contracts/graph.ts";
import { subscribe } from "../../../src/core/events.ts";
import { createFileStores } from "../../../src/store/file-stores.ts";
import { graphPaths } from "../../../src/store/graph.ts";
import { beforeWrite, releaseStoreLock } from "../../../src/store/marker.ts";
import type { SqlDriver } from "../../../src/store/sql/driver.ts";
import { openNodeSqlite } from "../../../src/store/sql/drivers/node-sqlite.ts";
import { graphDbFile, releaseGraphDb } from "../../../src/store/sql/open.ts";
import type { AdapterFactory, AnyLedger, StoreBundle } from "../harness.ts";

const TABLES: Record<AnyLedger, string> = { nodes: "ledger_nodes", chains: "ledger_chains", coverage: "ledger_coverage", checkpoints: "ledger_checkpoints", reviews: "ledger_reviews", reviewRemaps: "ledger_review_remaps" };

/** LH_STORAGE only for the open: the other adapters share this process, and the open's decision is what later writes use. */
function openAsSqlite(dir: string) {
	const old = process.env.LH_STORAGE;
	process.env.LH_STORAGE = "sqlite";
	try {
		return createFileStores(dir, path.join(dir, "auth.json"));
	} finally {
		if (old === undefined) delete process.env.LH_STORAGE;
		else process.env.LH_STORAGE = old;
	}
}

const factory: AdapterFactory = {
	name: "sqlite-app",
	capabilities: { revision: true, corruptLines: true, refusesAtOpen: true, commits: false },
	async open(dir): Promise<StoreBundle> {
		const s = openAsSqlite(dir);
		const formatFile = graphPaths(path.join(dir, "graph")).format;
		/** A second connection, as a hook is not a store write. `beforeWrite` first: the file exists only after a first write. */
		const withDb = (fn: (db: SqlDriver) => void) => {
			beforeWrite(dir);
			const db = openNodeSqlite(graphDbFile(dir));
			try { fn(db); } finally { db.close(); }
		};
		const setLineFormat = (v: number) => withDb((db) => db.run("UPDATE lh_meta SET value = ? WHERE key = 'line_format'", String(v)));
		return {
			graph: s.graphStore, chats: s.chatStore, jobs: s.jobStore, settings: s.settingsStore,
			sourceOrg: s.sourceOrganizationStore, prompts: s.promptOverrides, auth: s.authStore,
			render: { read: () => s.renderSettingsStore.readRenderSettings(), write: (raw) => s.renderSettingsStore.writeRenderSettings(raw) },
			events: { subscribe },
			hooks: {
				injectCorruptLine: (ledger, text) => withDb((db) => db.run(`INSERT INTO ${TABLES[ledger]} (line_json) VALUES (?)`, text)),
				stampNewerFormat: () => { setLineFormat(CURRENT_GRAPH_FORMAT_VERSION + 1); fs.mkdirSync(path.dirname(formatFile), { recursive: true }); fs.writeFileSync(formatFile, JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION + 1 })); },
				clearFormatStamp: () => { fs.rmSync(formatFile, { force: true }); setLineFormat(CURRENT_GRAPH_FORMAT_VERSION); },
			},
			dispose: () => { try { releaseGraphDb(dir); } finally { releaseStoreLock(dir); } },
		};
	},
};
export default factory;
