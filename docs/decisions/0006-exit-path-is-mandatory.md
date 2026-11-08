# 0006. An exit path out of DoltLite is mandatory

Status: Accepted (2026-11-08; spec D6)

## Context
DoltLite's on-disk format is beta.

## Decision
Before trusting DoltLite, the migration tool (PR4) must export back out to plain JSONL or plain SQLite (`.dump | sqlite3`), and a test must round-trip it.

## Consequences
- The round-trip guarantee is `export(import(export(x))) == export(x)`, after a defined normalisation (CB2 item 12). Golden fixtures with canonical bytes round-trip byte-identically.
- The Python skill refuses `graph.doltlite` with "run `pnpm run lh -- export`".
