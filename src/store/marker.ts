/**
 * The data-folder marker (ADR 0004, 0009) and the first-write rule.
 *
 * `<dataDir>/storage.json` = {"backend":"file"|"sqlite"|"doltlite","layout":1}.
 *  - Missing marker = file. LH_STORAGE is honoured only for an EMPTY folder
 *    (absent, or no entries); on a non-empty folder it is ignored, not a conflict.
 *  - Agreement = "the store the marker names exists and is valid". Leftover
 *    JSONL beside a named SQL store is ignored. For `file` the folder is the
 *    store: valid means not stamped newer (graph-format.ts).
 *  - A layout above CURRENT_LAYOUT raises StorageVersionError at open (R3);
 *    a corrupt marker or an unknown backend refuses too, never reads as missing.
 *  - OPEN NEVER WRITES. The marker and the locks are written on the first
 *    write through any data-folder store (`beforeWrite`), never on a read.
 *  - Two locks: the folder lock (`storage.json.lock`) always, and on doltlite also the
 *    lock of the store file (`graph.doltlite.lock`), because the driver only lets a
 *    lock of its own file recover. Marker lock first, store lock second, released in reverse.
 *
 * This build wires file, sqlite and doltlite. `adapterFor` is the ONE place an adapter is registered;
 * doltlite ships on darwin-arm64 and linux-x64 only and is refused elsewhere with NoAdapterError (win32-x64 waits on dolthub/doltlite-node#13: close() keeps the store's files open until GC, and Windows refuses rm/rename of an open file).
 * A first write that picks sqlite or doltlite takes the locks, creates and migrates the store
 * (`graph.sqlite`, `graph.doltlite`), and only then writes the marker, so the marker never names a missing store.
 */
import fs from "node:fs";
import path from "node:path";
import { acquireStoreLock, type LockEnv, type StoreLock } from "./sql/lock.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";
import { assertGraphFormat, StorageVersionError } from "./graph-format.ts";
import { doltliteDbFile, ensureDoltliteDb, ensureGraphDb, graphDbFile } from "./sql/open.ts";

export const CURRENT_LAYOUT = 1;
export const BACKENDS = ["file", "sqlite", "doltlite"] as const;
export type Backend = (typeof BACKENDS)[number];
export const MARKER_NAME = "storage.json";

/** The marker or LH_STORAGE is unusable: corrupt, unknown backend, bad layout. */
export class StorageMarkerError extends Error {
	override name = "StorageMarkerError";
	constructor(readonly file: string, reason: string) {
		super(`${file}: ${reason}`);
	}
}

/** The backend is valid but this build has no adapter for it. */
export class NoAdapterError extends Error {
	override name = "NoAdapterError";
	constructor(readonly backend: string, readonly file: string) {
		super(`${file}: this build has no adapter for ${backend}`);
	}
}

export const markerFile = (dataDir: string): string => path.join(/* turbopackIgnore: true */ dataDir, MARKER_NAME);
const isBackend = (v: unknown): v is Backend => typeof v === "string" && (BACKENDS as readonly string[]).includes(v);

/** The backends this build can run. */
export type RunnableBackend = "file" | "sqlite" | "doltlite";

/** Hosts the app runs DoltLite on. D5 packaged the addon for win32-x64 too, but win32-x64 waits on dolthub/doltlite-node#13: close() keeps the store's files open until GC, and Windows refuses rm/rename of an open file. */
const DOLTLITE_HOSTS = new Set(["darwin-arm64", "linux-x64"]);

/** The one place adapters are registered. doltlite only on DOLTLITE_HOSTS. `host` is for tests. */
export function adapterFor(backend: Backend, file: string, host: { platform: string; arch: string } = { platform: process.platform, arch: process.arch }): RunnableBackend {
	if (backend === "file" || backend === "sqlite") return backend;
	if (DOLTLITE_HOSTS.has(`${host.platform}-${host.arch}`)) return backend;
	throw new NoAdapterError(backend, file);
}

function folderIsEmpty(dir: string): boolean {
	try {
		return fs.readdirSync(dir).length === 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}

/** Parse the marker. Returns undefined when absent; refuses anything else that is not a valid marker. */
export function readMarker(file: string): { backend: Backend; layout: number } | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new StorageMarkerError(file, `cannot read the storage marker (${(error as NodeJS.ErrnoException).code ?? "error"})`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new StorageMarkerError(file, "the storage marker is not valid JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StorageMarkerError(file, "the storage marker is not an object");
	const { backend, layout } = value as { backend?: unknown; layout?: unknown };
	if (typeof layout === "number" && Number.isInteger(layout) && layout > CURRENT_LAYOUT) throw new StorageVersionError(file, layout, CURRENT_LAYOUT, "storage layout");
	if (typeof layout !== "number" || !Number.isInteger(layout) || layout < 1) throw new StorageMarkerError(file, `unsupported layout ${JSON.stringify(layout)} (this build supports ${CURRENT_LAYOUT})`);
	if (!isBackend(backend)) throw new StorageMarkerError(file, `unknown backend ${JSON.stringify(backend)}`);
	return { backend, layout };
}

/** Which backend this folder uses; never writes. Refuses per the rules above. */
export function resolveBackend(dataDir: string, env: Record<string, string | undefined> = process.env): RunnableBackend {
	const file = markerFile(dataDir);
	const marker = readMarker(file);
	if (marker) return adapterFor(marker.backend, file);
	const wanted = env.LH_STORAGE;
	if (wanted !== undefined && wanted !== "" && folderIsEmpty(dataDir)) {
		if (!isBackend(wanted)) throw new StorageMarkerError(file, `LH_STORAGE=${JSON.stringify(wanted)} is not a backend (file, sqlite, doltlite)`);
		return adapterFor(wanted, file);
	}
	return "file"; // missing marker = file; LH_STORAGE on a non-empty folder is ignored
}

/** The graph-family format stamp lives beside the graph ledgers. */
export const graphFormatFileIn = (dataDir: string): string => path.join(/* turbopackIgnore: true */ dataDir, "graph", "format.json");

/** Agreement (architecture 3): a marker that names sqlite or doltlite needs the store it names. Without a marker, LH_STORAGE is only an intent: the store is made on the first write. */
function assertAgreement(file: string, marker: { backend: Backend } | undefined, dataDir: string): void {
	const store = marker?.backend === "sqlite" ? graphDbFile(dataDir) : marker?.backend === "doltlite" ? doltliteDbFile(dataDir) : undefined;
	if (marker && store && !fs.existsSync(store)) {
		throw new StorageMarkerError(file, `the marker names ${marker.backend} but ${store} is missing; restore it, or remove ${MARKER_NAME} only if you mean to start a new folder`);
	}
}

/** The stores were built for one backend and the marker now names another (another process made the first write). Writing on would strand the data. */
function assertMarkerMatches(file: string, marker: { backend: Backend } | undefined, backend: RunnableBackend): void {
	if (marker && marker.backend !== backend) throw new StorageMarkerError(file, `this process opened the folder as ${backend} but the marker now names ${marker.backend}; restart so the stores match it`);
}

/** What this process built its stores on, per absolute folder. resolveBackend depends on what is in the folder, so asking it again after a stray file comes or goes can split the stores from the marker. On globalThis for the reason given at REGISTRY_KEY. */
const DECISIONS_KEY = "__lhStoreBackends";
function decisions(): Map<string, RunnableBackend> {
	const g = globalThis as unknown as Record<string, Map<string, RunnableBackend> | undefined>;
	return (g[DECISIONS_KEY] ??= new Map());
}

/** OPEN: resolve the backend and check the store is valid. Never writes; a missing folder is fine. Without a marker the first open's answer stands, for every later open and for the first write. */
export function openDataFolder(dataDir: string, env: Record<string, string | undefined> = process.env): RunnableBackend {
	const abs = path.resolve(dataDir);
	const file = markerFile(abs);
	const marker = readMarker(file);
	const backend = marker ? adapterFor(marker.backend, file) : (decisions().get(abs) ?? resolveBackend(abs, env));
	assertAgreement(file, marker, abs);
	assertGraphFormat(graphFormatFileIn(abs)); // render settings and positions stay files on every backend, and `file` is valid = not stamped newer
	decisions().set(abs, backend);
	return backend;
}

// ─── first write: marker + lock ──────────────────────────────────────────────

/** `lock` is the folder (marker) lock; `store` is the store file's lock, taken on doltlite only. */
export interface Held {
	lock: StoreLock;
	store?: StoreLock;
}
/** Next dev loads several module instances in one process and lock.ts refuses a live pid, its own included,
 *  so the handles live on globalThis keyed by absolute path (the __lhAuditLock pattern). */
const REGISTRY_KEY = "__lhStoreLocks";
function registry(): Map<string, Held> {
	const g = globalThis as unknown as Record<string, Map<string, Held> | undefined>;
	const map = (g[REGISTRY_KEY] ??= new Map());
	installExitHooks();
	return map;
}

/** Reverse of acquisition. Release is idempotent and removes only a lock that is still ours. */
function releaseHeld(held: Held): void {
	held.store?.release();
	held.lock.release();
}

/** Release every lock this process holds. Idempotent; reads the global registry, so any module copy may run it. */
function releaseAll(): void {
	const g = globalThis as unknown as Record<string, Map<string, Held> | undefined>;
	for (const held of g[REGISTRY_KEY]?.values() ?? []) releaseHeld(held);
	g[REGISTRY_KEY]?.clear();
}

/** Once per process (globalThis flag, so Next dev's duplicate modules do not stack listeners):
 *  release on exit, and on SIGTERM/SIGINT without swallowing the signal. */
function installExitHooks(): void {
	const g = globalThis as unknown as Record<string, boolean | undefined>;
	if (g.__lhStoreLockHooks) return;
	g.__lhStoreLockHooks = true;
	process.on("exit", releaseAll);
	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		const onSignal = (): void => {
			releaseAll();
			process.removeListener(sig, onSignal);
			// Others (Next, Electron shutdown) own the exit; if none remain, die with this signal.
			if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
		};
		process.on(sig, onSignal);
	}
}

/** Release this process's lock on a folder (tests, scripts). A later write re-acquires. */
export function releaseStoreLock(dataDir: string): void {
	const abs = path.resolve(dataDir);
	const held = registry().get(abs);
	if (held) releaseHeld(held);
	registry().delete(abs);
}

/** Held = we registered it AND every lock file still holds OUR lock (a test may have removed the folder, another process may have taken the file). */
export function holdsStoreLock(dataDir: string): boolean {
	const held = registry().get(path.resolve(dataDir));
	return held !== undefined && held.lock.held() && (held.store?.held() ?? true);
}

/** The marker lock, then (doltlite only) the store file's lock, so the driver can be handed a real held lock. A refusal on the second leaves the first released. */
export function takeFolderLocks(dataDir: string, backend: RunnableBackend, lockEnv?: LockEnv): Held {
	const abs = path.resolve(dataDir);
	const lock = acquireStoreLock(markerFile(abs), lockEnv);
	if (backend !== "doltlite") return { lock };
	try {
		return { lock, store: acquireStoreLock(doltliteDbFile(abs), lockEnv) };
	} catch (error) {
		lock.release();
		throw error;
	}
}

/**
 * Call before the first physical write through any data-folder store.
 * Refuses (layout, format), takes the locks for the life of the process
 * (a StoreLockedError names the holder), then writes the marker atomically if absent.
 * Returns the store file's lock when the backend has one (doltlite), else undefined.
 * `lockEnv` is for tests (fake pid/host); the app never passes it.
 */
export function beforeWrite(dataDir: string, lockEnv?: LockEnv): StoreLock | undefined {
	const abs = path.resolve(dataDir);
	const file = markerFile(abs);
	const existing = readMarker(file); // a newer or corrupt marker refuses the write too
	assertAgreement(file, existing, abs); // a sqlite marker whose database was deleted refuses writes too, before any lock
	// The open's answer. Resolved here only for a folder this process never opened, and BEFORE the lock:
	// the lock file makes the folder non-empty, which would hide LH_STORAGE. A refusal (bad value, no adapter) then leaves neither marker nor lock.
	const backend = decisions().get(abs) ?? resolveBackend(abs);
	assertMarkerMatches(file, existing, backend);
	if (!holdsStoreLock(abs)) {
		// Half a pair may survive (one lock file lost): release it before re-taking, or it would be left behind.
		const stale = registry().get(abs);
		if (stale) releaseHeld(stale);
		registry().delete(abs);
		fs.mkdirSync(abs, { recursive: true });
		registry().set(abs, takeFolderLocks(abs, backend, lockEnv));
	}
	const store = registry().get(abs)?.store;
	const locked = readMarker(file); // another process may have made the first write while this one waited to lock
	assertMarkerMatches(file, locked, backend);
	if (locked) return store;
	if (backend === "sqlite") ensureGraphDb(abs); // lock, then the store, then the marker: a marker never names a store that is missing
	if (backend === "doltlite") ensureDoltliteDb(abs, store!); // takeFolderLocks took the store lock for doltlite
	writeFileAtomicSync(file, `${JSON.stringify({ backend, layout: CURRENT_LAYOUT }, null, "\t")}\n`, { allowInPlaceFallback: true });
	return store;
}

/** Scripts: take the lock at start (after checking the folder opens), release in finally. */
export function lockDataFolder(dataDir: string, lockEnv?: LockEnv): StoreLock {
	openDataFolder(dataDir);
	beforeWrite(dataDir, lockEnv);
	const held = registry().get(path.resolve(dataDir))!;
	return { lockFile: held.lock.lockFile, held: () => held.lock.held() && (held.store?.held() ?? true), release: () => releaseStoreLock(dataDir) };
}
