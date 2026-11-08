# 0007. Blobs go in a plain-SQLite content-addressed store

Status: Accepted (2026-11-08; spec D7, moved off the DoltLite critical path by storage-architecture C5)

## Context
The versioned store holds no blobs today. Image snapshots live in chat JSON, already keyed by SHA-256. Demo HTML and SVG sit inside job results and messages.

## Decision
- File `blobs.sqlite`, plain SQLite (stock `node:sqlite`), append-only, never versioned. One table: `cas_objects(hash, byte_len, content_type, bytes)`, primary key = hash of the bytes.
- The store hashes the bytes itself (SHA-256 via `node:crypto`), so a key cannot name the wrong bytes. `INSERT OR IGNORE` makes duplicates a no-op.
- Write bytes first, then the referencing row; a crash between leaves a harmless orphan.
- Sniff the real content type from the leading bytes. The versioned store keeps only `(id, owner, ref, hash)` edges.

## Consequences
- Diffs stay small, versioned history never holds multi-MB bytes, and deleting a blob is a plain row delete.
- An independent, later lane. The first consumer is chat `imageSnapshots`; demo HTML and SVG need message-content rewriting, so they come later.
