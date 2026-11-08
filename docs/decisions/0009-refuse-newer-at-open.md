# 0009. Refuse a newer store at open, for reads and writes

Status: Accepted (2026-11-08; storage-architecture R3, C4)

## Context
Upstream checks the format version only in read paths (`graph-format.ts:45`). `appendLine`, `rewriteLedgers` and `writeSourceMap` never assert, so a newer folder refuses reads but accepts writes.

## Decision
One rule for all our stores: refuse at open, for reads and writes, when any of these is above what the build knows:
- `lh_meta.schema_version` above the top rung;
- `lh_meta.line_format` above `CURRENT_GRAPH_FORMAT_VERSION`;
- the `storage.json` `layout`.

## Consequences
- Refusal is a `StorageVersionError` naming the file, the found version and the supported version.
- The file adapter also keeps its per-operation check (`tests/schema-stamps.test.ts`).
- Guard: CB2 item 5 and the migration test "newer is refused".
