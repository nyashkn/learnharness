import type { MigrateOptions } from "../../migrate";
import type { Rung } from "../../rung";
import rung1 from "./0001_init";

/** Explicit list: bundlers cannot glob at runtime (R2). tests/sql/migrations.test.ts checks it against the files. */
export const blobRungs: readonly Rung[] = [rung1];

/** No line format: blobs.sqlite holds rows, not ledger lines. */
export const blobMigration = { kind: "blobs", rungs: blobRungs } satisfies Pick<MigrateOptions, "kind" | "rungs">;
