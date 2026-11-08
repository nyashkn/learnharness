# Facts and boundaries

`auto` means a check in `just ci` guards it (or will, once the named bead lands). `manual` means review only.

## Facts found in the code (v0.5.0, `713377f`)

| # | Fact | Check |
|---|---|---|
| 1 | 14 store-adapter import lines in 9 `src/server` files bypass `stores.ts`. | auto: ESLint server→store zone plus `eslint/leak-allowlist.mjs` |
| 2 | Every merge that simplifies chains calls `rewriteLedgers` (`core/graph.ts:274`), so the SQL rewrite must be fast and keep row order. | auto: contract suite (C1) |
| 3 | `graphRevision` stats the mtimes of 4 ledgers plus `positions.json`; it becomes `GraphStore.revision()`. | auto: contract suite |
| 4 | The newer-format check runs only on read paths. All our stores refuse at open, for reads and writes. | auto: contract suite |
| 5 | The versioned store holds no blobs today; image snapshots live in chat JSON, keyed by SHA-256. | manual |
| 6 | `zod` is installed but never imported. TypeBox is used for LLM tool arguments. | manual |
| 7 | Versioned stores use a `_datalib_meta` table, not `PRAGMA user_version`. | manual |
| 8 | `read_marks` is UI state. The projection cursor is written in the same transaction as the derived rows. | manual |

## Tooling facts

| Fact | Check |
|---|---|
| pnpm 11 reads only auth and registry settings from `.npmrc`. `nodeLinker: hoisted` and `allowBuilds` live in `pnpm-workspace.yaml`. | manual |
| pnpm 11 fails `install` on a dependency build script that `allowBuilds` does not list. | auto: `pnpm install --frozen-lockfile` in CI |
| pnpm ignores the npm `overrides` block in `package.json`. Overrides live in `pnpm-workspace.yaml`; KaTeX must stay on one version. | auto: `tests/katex-security.test.ts` |
| `package-lock.json` is gone. Upstream lockfile changes are re-applied with `pnpm import` or by hand. | manual |
| Every `tests/**/*.test.ts(x)` and `*.contract.ts` file must match a glob `ci` runs. | auto: `tests/test-globs.test.ts` |

## Boundaries

| ID | Boundary | Guard |
|---|---|---|
| CB1 | Domain ↔ ports (`src/core/ports.ts`) | ESLint zones; adapters end with `satisfies <Port>` |
| CB2 | Port ↔ adapter behaviour | Contract suite, run once per adapter factory found by glob |
| CB3 | SQL adapter ↔ driver | Engine-facts suite per driver; `check:pins` |
| CB4 | App ↔ bytes on disk | Migration tests, JSON Schema drift test, golden fixtures |
| CB5 | Untrusted input ↔ app | TypeBox `Value.Check` at the edge only; failing disk lines are counted and skipped |
| CB6 | Process ↔ store file | One writer per store file, through a lock file |
| CB7 | Seed module ↔ LearnHarness | Chat APIs only; `scripts/seed.ts` is the only composition root |
