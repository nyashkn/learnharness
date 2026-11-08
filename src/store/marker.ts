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
 *  - OPEN NEVER WRITES. The marker and the store lock are written on the first
 *    write through any data-folder store (`beforeWrite`), never on a read.
 *
 * This build wires only the file backend. `adapterFor` is the ONE place a
 * sqlite or doltlite adapter is added (S5, D3).
 */
import fs from "node:fs";
import path from "node:path";
import { acquireStoreLock, type LockEnv, type StoreLock } from "./sql/lock.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";
import { assertGraphFormat, StorageVersionError } from "./graph-format.ts";

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

export const markerFile = (dataDir: string): string => path.join(dataDir, MARKER_NAME);
const isBackend = (v: unknown): v is Backend => typeof v === "string" && (BACKENDS as readonly string[]).includes(v);

/** The one place adapters are registered. Only `file` exists in this build. */
function adapterFor(backend: Backend, file: string): "file" {
	if (backend === "file") return "file";
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
function readMarker(file: string): { backend: Backend; layout: number } | undefined {
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
export function resolveBackend(dataDir: string, env: Record<string, string | undefined> = process.env): "file" {
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
export const graphFormatFileIn = (dataDir: string): string => path.join(dataDir, "graph", "format.json");

/** OPEN: resolve the backend and check the store is valid. Never writes; a missing folder is fine. */
export function openDataFolder(dataDir: string, env: Record<string, string | undefined> = process.env): "file" {
	const backend = resolveBackend(dataDir, env);
	assertGraphFormat(graphFormatFileIn(dataDir)); // file backend: valid = not stamped newer
	return backend;
}

// ─── first write: marker + lock ──────────────────────────────────────────────

interface Held {
	lock: StoreLock;
}
/** Next dev loads several module instances in one process and lock.ts refuses a live pid, its own included,
 *  so the handles live on globalThis keyed by absolute path (the __lhAuditLock pattern). */
const REGISTRY_KEY = "__lhStoreLocks";
function registry(): Map<string, Held> {
	const g = globalThis as unknown as Record<string, Map<string, Held> | undefined>;
	return (g[REGISTRY_KEY] ??= new Map());
}

/** Release this process's lock on a folder (tests, scripts). A later write re-acquires. */
export function releaseStoreLock(dataDir: string): void {
	const abs = path.resolve(dataDir);
	registry().get(abs)?.lock.release();
	registry().delete(abs);
}

/** Held = we registered it AND its lock file is still there (a test may have removed the folder). */
export function holdsStoreLock(dataDir: string): boolean {
	const held = registry().get(path.resolve(dataDir));
	return held !== undefined && fs.existsSync(held.lock.lockFile);
}

/**
 * Call before the first physical write through any data-folder store.
 * Refuses (layout, format), takes the store lock for the life of the process
 * (a StoreLockedError names the holder), then writes the marker atomically if absent.
 * `lockEnv` is for tests (fake pid/host); the app never passes it.
 */
export function beforeWrite(dataDir: string, lockEnv?: LockEnv): void {
	const abs = path.resolve(dataDir);
	const file = markerFile(abs);
	const existing = readMarker(file); // a newer or corrupt marker refuses the write too
	// Resolve BEFORE the lock: the lock file makes the folder non-empty, which would hide LH_STORAGE.
	// A refusal (bad value, no adapter) then leaves neither marker nor lock.
	const backend = existing === undefined ? resolveBackend(abs) : undefined;
	if (!holdsStoreLock(abs)) {
		registry().delete(abs);
		fs.mkdirSync(abs, { recursive: true });
		registry().set(abs, { lock: acquireStoreLock(file, lockEnv) });
	}
	if (backend !== undefined) {
		writeFileAtomicSync(file, `${JSON.stringify({ backend, layout: CURRENT_LAYOUT }, null, "\t")}\n`, { allowInPlaceFallback: true });
	}
}

/** Scripts: take the lock at start (after checking the folder opens), release in finally. */
export function lockDataFolder(dataDir: string, lockEnv?: LockEnv): StoreLock {
	openDataFolder(dataDir);
	beforeWrite(dataDir, lockEnv);
	const held = registry().get(path.resolve(dataDir))!;
	return { lockFile: held.lock.lockFile, release: () => releaseStoreLock(dataDir) };
}
