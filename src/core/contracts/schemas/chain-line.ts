import { Type } from "typebox";
import { ProvenancePointSchema } from "./provenance-point.ts";

export const ChainLineSchema = Type.Object(
	{
		id: Type.String(),
		premises: Type.Array(Type.String(), { minItems: 1 }),
		conclusion: Type.String(),
		provenance: Type.Array(ProvenancePointSchema),
		createdAt: Type.String(),
	},
	{ $id: "lh.graph.chain-line.v1", additionalProperties: true },
);
