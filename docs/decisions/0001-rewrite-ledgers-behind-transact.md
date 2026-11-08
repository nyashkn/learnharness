# 0001. rewriteLedgers stays, behind transact

Status: Accepted (2026-11-08; spec D1)

## Context
`mergeFindings` (`src/core/graph.ts`) needs one atomic unit of work. Every merge that simplifies chains calls `rewriteLedgers` (storage-architecture C2). Both reference forks agree a transaction is needed.

## Decision
- Keep the port method `rewriteLedgers`; do not change on-disk semantics now.
- Add `GraphStore.transact(label, fn)`. The file adapter keeps its atomic temp file plus rename and the existing lock.
- SQL adapters compute the difference between current and kept lines, then delete or insert only that difference inside the transaction. No whole-table rewrite, so DoltLite diffs stay readable.

## Consequences
- The SQL rewrite must be fast and keep row order (CB2 item 7).
- Rejected for now: "deletions as records". It removes rewriting but changes read semantics and the format version. Revisit only if multi-device sync is wanted; that is a sync decision, not a back-end decision.
- Guard: contract suite `tests/contract/*.contract.ts`.
