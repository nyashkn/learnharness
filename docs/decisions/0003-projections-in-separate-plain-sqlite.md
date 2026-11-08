# 0003. Projections live in a separate plain-SQLite file

Status: Accepted (2026-11-08; spec D3, revised after datalib)

## Context
Derived tables (`node`, `node_alias`, `node_provenance`, `chain`, `chain_premise`, plus an FTS5 index over statements) are wanted later. datalib measured FTS5 inside DoltLite at 375 MB against 97 MB in plain SQLite, with about 180 KB growth per commit. Its own search index is plain SQLite for that reason.

## Decision
- Projections come later and live in their own plain SQLite file (`projections.sqlite`), opened with stock `node:sqlite`, not DoltLite.
- They are rebuilt from the ledger lines and are never the source of truth.

## Consequences
- Enables "everything needed to derive Y" (recursive CTE) and better candidate search for the auditor.
- A cursor is written in the same transaction as the derived rows; a mismatch rebuilds in full (storage-architecture 4.3).
- Derived stores never migrate; they rebuild on a hash mismatch (R7).
