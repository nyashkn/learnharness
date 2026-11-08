# 0005. DoltLite commit discipline

Status: Accepted (2026-11-08; spec D5, from datalib)

## Context
datalib's measurements show per-statement commits and many writers bloat DoltLite history.

## Decision
- One DoltLite commit per `transact` (one extraction batch), never per statement and never in a loop.
- One writer per file, enforced by an app-owned lock, with connection pool size 1.
- Readers open `<file>@<hash>` read-only, so they see a snapshot and never block the writer.
- Blobs (demo HTML, SVG, image snapshots) stay outside the versioned store.
- Keep keys adjacent and append-only; `(seq, line_json)` is the favourable case.

## Consequences
- A nested `transact` joins the outer one (CB2 item 11), so one outer transaction is one commit.
- The lock is `<store>.lock` (CB6): a second writer is refused with the holder named.
