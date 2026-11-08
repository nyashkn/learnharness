# 0004. One back-end per data folder; only graph data is versioned (Option B)

Status: Accepted (2026-11-08, user decision; spec D4, Option B)

## Context
- DoltLite rejects a transaction that writes more than one file-backed database, and datalib keeps many small files.
- Chats rewrite often and would bloat DoltLite history (datalib measured 439 MB falling to 15 MB when one transaction replaced 200 commits).
- A deleted row stays reachable from older commits; datalib's docs say even `dolt_gc` keeps it (not tested by us). Chat text is the most private data.

## Decision
- A `storage.json` marker in the data folder names the back-end. `LH_STORAGE` is honoured only for an empty folder.
- Only graph ledgers, coverage and sources are versioned. Chats, jobs and settings stay files or plain SQLite. Blobs go to a plain-SQLite CAS (ADR 0007).
- Option A (everything in one DoltLite file) was not chosen.

## Consequences
- Cross-store operations (deleting a session also removes its graph provenance) are ordered and idempotent, repaired from the coverage ledger. There is no cross-file atomicity.
- "Delete my session" stays real for chats. Graph statements and provenance ids remain in history, so graph deletion needs its own test; a purge command exists (bead D4).
