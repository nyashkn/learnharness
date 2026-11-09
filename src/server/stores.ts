/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import { chatStore } from "../store/chats.ts";
import { graphStore, purgeLegacyLedgers } from "../store/graph.ts";
import { sourceOrganizationStore } from "../store/source-organization.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { authStore } from "../store/auth.ts";
import { promptOverrides } from "../store/prompt-overrides.ts";
import { renderSettingsStore } from "../store/render-settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { PATHS } from "../../config.ts";
import { beforeWrite, openDataFolder, type Backend } from "../store/marker.ts";
import { createSqlGraphStores } from "../store/sql/open.ts";
import { emit } from "../core/events.ts";
import type { Stores } from "../core/ports.ts";
// OPEN: the marker and format check, once, at module load. A folder this build must not touch
// (newer layout, corrupt marker, a backend with no adapter, a newer graph format) fails here, for
// reads and writes alike. It never writes and a missing folder is fine (`next build`, first run).
const backend = openDataFolder(PATHS.data);
export const storageBackend: Backend = backend;
// A versioned store keeps deleted content in its history until purge; the delete dialog says so.
export const keepsHistoryFor = (b: Backend): boolean => b === "doltlite";
// sqlite, doltlite: the ledgers and sources live in the store file, graph.sqlite or graph.doltlite (opened here, eagerly, when it exists); the file graphStore only serves positions.
const graph = backend !== "file" ? createSqlGraphStores(PATHS.data, graphStore, emit, beforeWrite, backend) : { graphStore, sourceOrganizationStore };
purgeLegacyLedgers(PATHS.graph); // after every refusal, the sqlite one included: a refused folder keeps its legacy files

/** The wired adapters, typed against the ports. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores: Stores = {
	chatStore,
	graphStore: graph.graphStore,
	sourceOrganizationStore: graph.sourceOrganizationStore,
	jobStore,
	settingsStore,
	authStore,
	promptOverrides,
	renderSettingsStore,
};

// Named handles and the raw-record aliases the routes use (moved from the barrel).
export { settingsStore, authStore, promptOverrides, renderSettingsStore };
export { readRenderSettings, writeRenderSettings } from "../store/render-settings.ts";
export { readSettings as readSettingsRecord, writeSettings as writeSettingsRecord } from "../store/settings.ts";

export type { Stores };

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}
