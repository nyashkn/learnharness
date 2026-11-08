import { Type } from "typebox";
import { ProvenancePointSchema } from "./provenance-point.ts";

export const NodeLineSchema = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		statement: Type.String(),
		aliases: Type.Array(Type.String()),
		createdAt: Type.String(),
		provenance: Type.Array(ProvenancePointSchema),
	},
	{ $id: "lh.graph.node-line.v1", additionalProperties: true },
);
