---
paths:
  - "src/store/**"
  - "src/core/ports.ts"
---

# Storage rules (CB2 behaviour list and write path)

Gate: `just ci`. Detail: `docs/architecture/storage-architecture.md` sections 2.1 and 6; decisions: `docs/decisions/`.

1. Golden fixtures give an identical `graphSnapshot` (`tests/golden-fixtures.test.ts`).
2. A corrupt line is skipped, counted, and exposed as `corruptLines()`.
3. Duplicate lines survive and fold at read time.
4. A throw inside `transact` leaves no trace: no lines, rewrite, revision bump or events.
5. A newer store is refused at open, reads and writes (ADR 0009; `tests/schema-stamps.test.ts`).
6. Re-running an import is idempotent (multiset compare).
7. `rewriteLedgers` leaves exactly the kept lines, in kept order.
8. Lines come back in append order (`seq`).
9. `revision()` changes after every committed write, and only then.
10. Events are emitted after commit, never inside a rolled-back transaction.
11. A nested `transact` joins the outer one: one outer transaction, one DoltLite commit.
12. Export/import round trip: CRLF becomes LF, blank lines and a torn tail are dropped and counted.
13. Positions and render settings stay outside the transaction.
14. Read-your-writes: reads inside `transact` see disk plus pending writes.
15. Order: append, rewrite, append keeps call order.
16. Bare writes auto-wrap in `transact` labelled `auto:<method>`; bump and seal only when `changes > 0`.
17. Failure modes: async `fn` rolls back and throws; a caught inner throw makes the outer rollback-only; a seal failure after COMMIT is logged, and the next transaction seals `recovered: <label>`.

Checks for 1-17: the contract suite `tests/contract/*.contract.ts` (one run per adapter factory, found by glob).

Write path: `mergeFindings` calls `store.transact(label, fn)`. SQL: BEGIN IMMEDIATE, rows, `lh_meta.revision += 1` when `changes > 0`, COMMIT, `seal(label)`, emit events. File: replay the op log in call order. The audit lock and the positions write stay outside `transact`.

Never edit a released migration rung (a PreToolUse hook and the R6 test guard it; add a new rung). Only `src/store/sql/drivers/**` imports `node:sqlite` or `@dolthub/doltlite` (ESLint). TypeBox, not zod.
