# 0012. Purge history is a separate command

Status: Accepted (2026-11-08, Njui, Plannotator Inbox)

## Context
DoltLite keeps every version of the store. After a normal delete, the deleted statement stays reachable in `dolt_log`, `dolt_at_*`, the `dolt_history_*` tables and the raw file bytes.

## Decision
Delete keeps a limited promise. A separate `purge history` command erases the old versions. DoltLite stays disabled until purge is built and tested.

Wording (Njui, Plannotator Inbox, 2026-11-09). The delete wording applies to DoltLite stores only:
- Delete: "Removed from your graph and every view. It stays in this store's version history until you purge history."
- Purge: "Purge history permanently erases all earlier versions of your graph, including anything you deleted. This can't be undone. A backup is saved at <path>; it still contains the deleted content until you delete that file."

Purge squashes all history into one commit after the root, then runs `dolt_gc`. Deleted text is then gone from SQL history and from the file bytes.

## Consequences
- History before the purge is lost.
- A backup is written first, and it still holds the deleted content.
- Purge asks you to close the app and re-run with `--yes`.
- Purge refuses a non-DoltLite backend, a missing store, a store in use, a store stamped newer than the build, and other branches or tags that would keep old history reachable.
- Command: `pnpm run lh -- purge [--data-dir <path>] [--yes]`.
- Guard: `tests/sql/purge.doltlite.test.ts`. A marker is found before the purge and absent after, including a raw byte scan.
