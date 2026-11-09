/**
 * The file backend's factory set for ONE data folder: every store built from
 * directories, none from config singletons. Scripts and tests use this; the app's
 * singletons (src/server/stores.ts) are built from the same factories over config paths.
 */
import path from "node:path";
import type { Stores } from "../core/ports.ts";
import { createAuthStore } from "./auth.ts";
import { createChatStore } from "./chats.ts";
import { createGraphStore, purgeLegacyLedgers } from "./graph.ts";
import { createJobStore } from "./jobs.ts";
import { beforeWrite, lockDataFolder, openDataFolder } from "./marker.ts";
import { createPromptOverrides } from "./prompt-overrides.ts";
import { createRenderSettingsStore } from "./render-settings.ts";
import { createSettingsStore } from "./settings.ts";
import { createSourceOrganizationStore } from "./source-organization.ts";
import { emit } from "../core/events.ts";
import { createSqlGraphStores } from "./sql/open.ts";
import type { LockEnv } from "./sql/lock.ts";

/** OPEN a data folder (refuses a newer or unusable one, never writes) and build its stores. `authFile` lives outside the folder. */
export function createFileStores(dataDir: string, authFile: string): Stores {
	const backend = openDataFolder(dataDir);
	const graphDir = path.join(dataDir, "graph");
	const fileGraph = createGraphStore(graphDir, { dataDir });
	purgeLegacyLedgers(graphDir); // only after open succeeded: a refused folder keeps its files
	// On sqlite the ledgers and sources live in graph.sqlite; the file graph store only serves positions (a script must never write JSONL beside the database).
	const graph = backend === "sqlite"
		? createSqlGraphStores(dataDir, fileGraph, emit, beforeWrite)
		: { graphStore: fileGraph, sourceOrganizationStore: createSourceOrganizationStore(graphDir, fileGraph, { dataDir }) };
	return {
		chatStore: createChatStore(path.join(dataDir, "chats"), { dataDir }),
		graphStore: graph.graphStore,
		sourceOrganizationStore: graph.sourceOrganizationStore,
		jobStore: createJobStore(path.join(dataDir, "jobs"), { dataDir }),
		settingsStore: createSettingsStore(dataDir),
		authStore: createAuthStore(authFile),
		promptOverrides: createPromptOverrides(path.join(dataDir, "prompts"), { dataDir }),
		renderSettingsStore: createRenderSettingsStore(graphDir, { dataDir }),
	};
}

/**
 * Run a script against a data folder: take the store lock first (a StoreLockedError names the
 * holder, e.g. the running server), release it in finally. A refusal is printed and sets exit code 1.
 */
export async function runStoreScript(dataDir: string, authFile: string, main: (stores: Stores) => void | Promise<void>, lockEnv?: LockEnv): Promise<void> {
	let lock: ReturnType<typeof lockDataFolder> | undefined;
	try {
		lock = lockDataFolder(dataDir, lockEnv);
		await main(createFileStores(dataDir, authFile));
	} catch (error) {
		if (error instanceof Error && ["StoreLockedError", "StorageVersionError", "StorageMarkerError", "NoAdapterError"].includes(error.name)) {
			console.error(`[store] refused: ${error.message}`);
			process.exitCode = 1;
			return;
		}
		throw error;
	} finally {
		lock?.release();
	}
}
