import type { MigrateOptions } from "../../migrate";
import type { Rung } from "../../rung";
import rung1 from "./0001_init";
import rung2 from "./0002_accept_rank_review";

/** Explicit list: bundlers cannot glob at runtime (R2). tests/sql/migrations.test.ts checks it against the files. */
export const seedRungs: readonly Rung[] = [rung1, rung2];

/** No line format: seeds.sqlite holds rows, not ledger lines. */
export const seedMigration = { kind: "seeds", rungs: seedRungs } satisfies Pick<MigrateOptions, "kind" | "rungs">;
