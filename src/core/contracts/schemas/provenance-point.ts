import { Type } from "typebox";

/** (chatId, messageId) pair — mirrors isProvenancePoint in store/graph.ts. */
export const ProvenancePointSchema = Type.Object({ chatId: Type.String(), messageId: Type.String() }, { additionalProperties: true });
