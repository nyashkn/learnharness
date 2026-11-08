import { Type } from "typebox";

// shortcut: Type.Number() rejects Infinity, but JSON.parse("1e999") yields it and the hand guard
// (typeof === "number") accepts it, so the runtime tokens is a typeof refinement. The JSON export swaps in
// {type:"number"} (CoverageLineExportSchema), because Python validators count inf as a number.
const AnyJsonNumber = Type.Refine(
	Type.Any({ description: "JSON number; non-finite values such as 1e999 are accepted" }),
	(v) => typeof v === "number",
);

export const CoverageLineSchema = Type.Object(
	{ chatId: Type.String(), fp: Type.String(), tokens: AnyJsonNumber, foldedAt: Type.String() },
	{ $id: "lh.graph.coverage-line.v1", additionalProperties: true },
);

/** The schema written to docs/architecture/schemas: same as the runtime one, but tokens says type number. */
export const CoverageLineExportSchema = {
	...CoverageLineSchema,
	properties: { ...CoverageLineSchema.properties, tokens: { type: "number" } },
};
