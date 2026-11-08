import { Type } from "typebox";

export const CheckpointLineSchema = Type.Object(
	{ chatId: Type.String(), foldedAt: Type.String() },
	{ $id: "lh.graph.checkpoint-line.v1", additionalProperties: true },
);
