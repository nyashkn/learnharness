# Failpoint matrix (lh-o0a)

Each failpoint appears **once**. `tests/contract/failpoints-coverage.contract.ts` parses this table and fails when a
row is duplicated, a category is missing or unknown, a test id is not declared in `tests/contract/**`, or a `todo`
row does not name an owning bead that the declaring file also carries.
A test id lives in `tests/contract/**` or `tests/sql/**`; an id that exists in both (`C1` is in each) is written `<file>#<id>` so the row cannot be satisfied by the wrong one. It runs under `pnpm run test:contract`
(imported by `model-based.contract.ts`).

Scope: `all` = every adapter (file now, sqlite, doltlite via the glob); `sql` = SQL driver level, run over the real
node:sqlite driver wrapped by `src/store/sql/drivers/faulty.ts` (test-only). Crash atomicity across files does not
exist for the file adapter, so crash rows are SQL-only. Adapter-level SQL rows point at the real tests in `tests/sql/graph-store.test.ts` (S = seal, C = crash); the DoltLite row is `todo` until D3.

| category | failpoint | scope | test id | status |
|---|---|---|---|---|
| crash-before | crash before each write step | sql | FP-SQL-BEFORE | test |
| crash-after | crash after each write step | sql | FP-SQL-AFTER | test |
| crash-commit | failure on COMMIT | sql | FP-SQL-COMMIT | test |
| torn-tail | torn (unterminated) tail | all | E5 | test |
| throw-in-transact | throw inside transact | all | D2 | test |
| async-fn | async fn passed to transact | all | N13 | test |
| caught-inner-throw | nested throw caught by the outer fn | all | N8 | test |
| lock-contention-busy | second writer on the SQL write lock (SQLITE_BUSY) | sql | FP-SQL-BUSY | test |
| lock-contention-store | store lock held by a live process | sql | FP-LOCK-HELD | test |
| stale-lock | lock left by a dead process | sql | FP-LOCK-STALE | test |
| newer-version-open | newer format refused at open | all | N3 | test |
| newer-version-write | newer format refuses writes | all | G2 | test |
| seal-failure-driver | seal failure after COMMIT, commit stays durable | sql | FP-SQL-SEAL | test |
| seal-failure-adapter | seal failure after COMMIT logged, next transaction seals `recovered:` | sql | tests/sql/graph-store.test.ts#S2 | test |
| disk-full | disk full mid-transaction | sql | FP-SQL-ENOSPC | test |
| corrupt-line | corrupt line skipped and counted | all | N2 | test |
| rewrite-modified-copies | rewrite with modified copies of kept lines | all | MB3 | test |
| sql-adapter-crash | crash atomicity through the sqlite GraphStore | sql | tests/sql/graph-store.test.ts#C1 | test |
| doltlite-crash | crash atomicity through the doltlite GraphStore | sql | FP-DOLT-CRASH | todo:lh-bkg |
