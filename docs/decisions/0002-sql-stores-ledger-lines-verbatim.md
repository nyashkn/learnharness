# 0002. SQL stores ledger lines verbatim

Status: Accepted (2026-11-08; spec D2, refined by storage-architecture section 4.1)

## Context
The file store and the SQL store must return identical results by construction, so contract tests can compare them byte for byte.

## Decision
- Four ledger tables, one each for node lines, chain lines, coverage and sessions, shaped `(seq INTEGER PRIMARY KEY, line_json TEXT NOT NULL)`.
- Refinement of the spec: `seq INTEGER PRIMARY KEY`, not `AUTOINCREMENT`. Both engines assign `max(rowid)+1`, and there is no `sqlite_sequence` table to churn in DoltLite history.
- Folding (first line wins, aliases union, provenance union) stays in `src/core/graph.ts`, unchanged. Corrupt lines are skipped on read, as today.

## Consequences
- No recursive CTEs or FTS5 directly on this data; handled by ADR 0003.
- An engine-facts test must confirm rowid assignment and ordering in DoltLite (MUST-CHECK).
- Lines are returned in append order (`seq`), because the first line for an id defines the node or chain (CB2 item 8).
