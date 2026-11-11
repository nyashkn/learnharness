/**
 * Blob store — content-addressed bytes in plain SQLite (ADR 0007, spec D7).
 * The store hashes the bytes itself, so a key cannot name the wrong bytes; INSERT OR IGNORE makes a
 * duplicate a no-op. Each call opens, migrates (a newer file is refused, ADR 0009), acts and closes:
 * callers hold no handle, so nothing blocks temp-dir cleanup on Windows. Reads never create the file.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import type { SqlDriver } from "../sql/driver";
import { openNodeSqlite } from "../sql/drivers/node-sqlite";
import { migrate } from "../sql/migrate";
import { blobMigration } from "../sql/migrations/blobs/index";

export interface BlobInfo {
	hash: string;
	contentType: string;
	byteLen: number;
}

export interface BlobStore {
	/** Store the bytes under their own SHA-256. Committed (synchronous=FULL) before this returns. */
	put(bytes: Uint8Array): BlobInfo;
	/** The bytes, or undefined when absent. A missing blobs.sqlite reads as absent and is not created. */
	get(hash: string): (BlobInfo & { bytes: Uint8Array }) | undefined;
	/** Delete every row whose hash is not in `keep`, in one transaction; returns rows deleted. A missing blobs.sqlite is a no-op and is not created. */
	sweep(keep: ReadonlySet<string>): number;
}

const startsWith = (b: Uint8Array, magic: readonly number[], at = 0) => magic.every((m, i) => b[at + i] === m);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Content type from the leading bytes, never from a caller. shortcut: no SVG/HTML sniffing, upgrade with the demo-HTML lane. */
export function sniffContentType(b: Uint8Array): string {
	if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return "image/gif";
	if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "image/webp";
	if (startsWith(b, ascii("%PDF-"))) return "application/pdf";
	return "application/octet-stream";
}

export interface BlobStoreOptions {
	/** For tests (capture the handle). */
	open?: (file: string) => SqlDriver;
	lhVersion?: string;
}

/** R5: `blobs.bak-v<from>-<ts>.sqlite` beside the store. */
const backupPathFor = (file: string) => (from: number): string =>
	path.join(path.dirname(file), `blobs.bak-v${from}-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);

export function createBlobStore(file: string, opts: BlobStoreOptions = {}): BlobStore {
	const open = opts.open ?? ((f: string) => openNodeSqlite(f));
	function withDb<T>(fn: (db: SqlDriver) => T): T {
		const db = open(file);
		try {
			migrate(db, { ...blobMigration, lhVersion: opts.lhVersion ?? pkg.version, backupPath: backupPathFor(file) });
			return fn(db);
		} finally {
			db.close();
		}
	}
	return {
		put(bytes) {
			const info = { hash: createHash("sha256").update(bytes).digest("hex"), contentType: sniffContentType(bytes), byteLen: bytes.byteLength };
			fs.mkdirSync(path.dirname(file), { recursive: true });
			withDb((db) => db.run("INSERT OR IGNORE INTO cas_objects (hash, byte_len, content_type, bytes) VALUES (?, ?, ?, ?)", info.hash, info.byteLen, info.contentType, bytes));
			return info;
		},
		get(hash) {
			if (!/^[a-f0-9]{64}$/.test(hash) || !fs.existsSync(file)) return undefined;
			const row = withDb((db) => db.get<{ byte_len: number; content_type: string; bytes: Uint8Array }>("SELECT byte_len, content_type, bytes FROM cas_objects WHERE hash = ?", hash));
			return row && { hash, contentType: row.content_type, byteLen: Number(row.byte_len), bytes: row.bytes };
		},
		sweep(keep) {
			if (!fs.existsSync(file)) return 0;
			// shortcut: hashes are listed then deleted one by one (no giant NOT IN), upgrade: a temp table when the CAS holds millions of rows.
			return withDb((db) =>
				db.transaction(() => {
					let n = 0;
					for (const { hash } of db.all<{ hash: string }>("SELECT hash FROM cas_objects")) if (!keep.has(hash)) n += db.run("DELETE FROM cas_objects WHERE hash = ?", hash).changes;
					return n;
				}),
			);
		},
	};
}
