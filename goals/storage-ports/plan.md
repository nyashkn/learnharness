# Plan

The ledger is the plan. `bd ready --type task --json` lists what can start now, and `bd show <id>` gives each bead's Files, Gate and Acceptance Criteria. Its source is the workspace file `docs/plan/beads/build_plan_graph.py`.

| Wave | Beads |
|---|---|
| 0 | G0, Q, F1 |
| 1 | S1, P2, P1, C1, R1, F2, S4 |
| 2 | S2, P2b, C2, D1, K1, K3 |
| 3 | P3, S3, D2, D4, M2, J1, K2 |
| 4 | F3, RP, RS, RD, D5, B1, K4 |
| 5 | S5, RK, GK |
| 6 | GB, M1, U0, K5, R2 |
| 7 | D3, R3 |
| 8 | RR |

Critical path:

- Ports: F1 → P2 → P2b → P3 → RP → S5 → R2 → R3 → RR.
- SQL: F1 → S1 → S2 → S3 → RS → S5.

Hotspot files have one owner per wave, enforced by bead edges:

| File | Order |
|---|---|
| `package.json`, `pnpm-lock.yaml` | F1, then D1, then D2 |
| `eslint.config.mjs` | F1, then F2 (P1 edits only `eslint/leak-allowlist.mjs`) |
| `src/core/ports.ts` | P1 and P2 in parallel, different regions; then P2b, P3, J1 |
| `src/server/stores.ts` | P1, P3, S5, D3 |
| `src/store/graph.ts` | P2, P2b, S5 |
