import { CURRENT_GRAPH_FORMAT_VERSION } from "../../../../core/contracts/graph";
import type { MigrateOptions } from "../../migrate";
import type { Rung } from "../../rung";
import rung1 from "./0001_init";

/** Explicit list: bundlers cannot glob at runtime (R2). tests/sql/migrations.test.ts checks it against the files. */
export const graphRungs: readonly Rung[] = [rung1];

export const graphMigration = { kind: "graph", rungs: graphRungs, lineFormat: CURRENT_GRAPH_FORMAT_VERSION } satisfies Pick<MigrateOptions, "kind" | "rungs" | "lineFormat">;
