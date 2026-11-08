# Goal: storage ports, SQL and DoltLite, cold start, SRS

Put LearnHarness storage behind ports, add SQLite and DoltLite backends for the graph ledgers, coverage and sources, seed new users from their session history, and add spaced repetition.

## Done when

- Every store is reached through a port in `src/core/ports.ts`, and `src/server` imports adapters only through `src/server/stores.ts` (`eslint/leak-allowlist.mjs` is empty).
- The contract suite in `tests/contract/` passes for every adapter, and every failpoint row has a test.
- DoltLite can be selected on macOS arm64, with a tested exit path and a tested purge-history command.
- Cold start proposes teaching sessions from session history, with redaction always on.
- The SRS epic ships FSRS replay, the review ledger (graph rung 0002) and the practice flow.
- `just ci` is green on `main`.

## Where things are

- Work queue: the beads ledger (prefix `lh`). Start with `just ready`, then `bd show <id>`.
- Testable facts and boundaries: `facts.md`. Order of work: `plan.md`.
- Full design: the workspace `docs/` folder beside this fork (`architecture/storage-architecture.md`, `spec/*`). Briefs give its absolute path.
