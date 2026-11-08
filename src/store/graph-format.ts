/**
 * The graph-family FORMAT STAMP (schema-versioning wave, owner 2026-10-10):
 * data/graph/format.json — one sidecar versioning the whole graph dir
 * family (the four JSONL ledgers, sources.json, render-settings.json).
 * JSONL ledgers can't carry inline stamps without per-line bloat, and the
 * JSON files share the family's fate, so the stamp lives beside them.
 * positions.json is rebuildable (owner ruling) and needs no protection.
 *
 * The contract:
 *  - LAZY v1: NO sidecar = v1 (the pre-stamp world stays valid forever);
 *    the first graph-family WRITE creates it. Reads never write.
 *  - Honest refusal (owner: refuse-honestly ruling): a sidecar stamped
 *    NEWER than this build (the downgrade scenario — user reverted the
 *    app) makes graph-family reads THROW. Read-modify-write stores must
 *    never rewrite what they don't understand; a ledger store must never
 *    silently skip lines it can't interpret as current-format data.
 *
 * Version constants: contracts/graph.ts CURRENT_GRAPH_FORMAT_VERSION.
 */

import fs from "node:fs";
import path from "node:path";
import { GRAPH_FORMAT_FILE } from "../../config.ts";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../core/contracts/graph.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

function stampedVersion(formatFile: string): number | null {
	let raw: string;
	try {
		raw = fs.readFileSync(formatFile, "utf-8");
	} catch {
		return null; // no sidecar — the lazy-v1 pre-stamp world
	}
	try {
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : null;
	} catch {
		return null; // corrupt sidecar reads as unstamped (v1), not fatal
	}
}

/** A data folder stamped by a NEWER build than this one (item 5). */
export class StorageVersionError extends Error {
	override name = "StorageVersionError";
	constructor(readonly file: string, readonly found: number, readonly supported: number, kind: "graph format" | "storage layout" = "graph format") {
		super(
			kind === "graph format"
				? `Graph data is stamped with format version ${found}, but this build understands only ${supported}. ` +
						"The app is older than its data — upgrade the app before touching the knowledge map."
				: `${file}: the data folder uses storage layout ${found}, but this build understands only ${supported}. ` +
						"The app is older than its data — upgrade the app before opening this folder.",
		);
	}
}

/** GUARD for every graph-family read AND write: throws when the data dir was
 *  written by a NEWER build. Never writes (the golden fixtures pin reads as
 *  byte-identical). */
export function assertGraphFormat(formatFile: string = GRAPH_FORMAT_FILE): void {
	const v = stampedVersion(formatFile);
	if (v !== null && v > CURRENT_GRAPH_FORMAT_VERSION) throw new StorageVersionError(formatFile, v, CURRENT_GRAPH_FORMAT_VERSION);
}

/** WRITE-SIDE STAMP: creates the sidecar on the first graph-family write
 *  (lazy); afterwards a no-op existence-wise. Callers keep their own mkdir. */
export function ensureGraphFormat(formatFile: string = GRAPH_FORMAT_FILE): void {
	assertGraphFormat(formatFile);
	if (stampedVersion(formatFile) !== null) return;
	fs.mkdirSync(path.dirname(formatFile), { recursive: true });
	writeFileAtomicSync(formatFile, JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION }, null, "\t") + "\n", { allowInPlaceFallback: true });
}
