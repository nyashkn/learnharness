import { Type } from "typebox";

const lits = (...v: string[]) => Type.Union(v.map((x) => Type.Literal(x)));

export const ReviewLineSchema = Type.Object(
	{
		id: Type.String(),
		chatId: Type.String(),
		problemCallId: Type.String(),
		at: Type.String(),
		targets: Type.Array(Type.String(), { minItems: 1 }),
		outcome: lits("solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"),
		rung: Type.Union([lits("R0", "R1", "R2", "R3", "R4", "R5"), Type.Null()]),
		mode: Type.Optional(lits("recall", "discrimination", "composition")),
		missClass: Type.Optional(Type.Union([lits("cue", "discrimination", "execution", "careless", "structural"), Type.Null()])),
		surface: Type.Optional(Type.String()),
		confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
	},
	{ $id: "lh.graph.review-line.v1", additionalProperties: true },
);

export const ReviewRemapLineSchema = Type.Object({ from: Type.String(), to: Type.String() }, { $id: "lh.graph.review-remap-line.v1", additionalProperties: true });
