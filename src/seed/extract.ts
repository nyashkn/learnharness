import { Type } from "typebox";
import { Value } from "typebox/value";
import { clipSnippet } from "./egress";
import type { AllowEgress, HarvestItem, LlmPort } from "./types";

export const DraftSchema = Type.Object({
	title: Type.String(),
	why: Type.String(),
	kind: Type.Union([Type.Literal("concept"), Type.Literal("skill"), Type.Literal("tool"), Type.Literal("pattern")]),
	evidenceIds: Type.Array(Type.String()),
});

export interface ProposalDraft {
	title: string;
	why: string;
	kind: "concept" | "skill" | "tool" | "pattern";
	evidenceIds: string[];
}

export type ExtractResult =
	| { kind: "draft"; draft: ProposalDraft }
	| { kind: "skipped"; reason: "egress-denied" | "llm-failed" | "invalid-output" };

export async function extractDraft(
	cluster: readonly HarvestItem[],
	deps: { llm: LlmPort; allowEgress: AllowEgress },
): Promise<ExtractResult> {
	// K-D6: the check runs per item, so an opted-out project's text never reaches the prompt.
	const sent = cluster.filter((item) => deps.allowEgress(item.project));
	if (sent.length === 0) return { kind: "skipped", reason: "egress-denied" };

	const prompt = [
		"Write one teaching session for the notes below. They come from one cluster of related work. The topic may be code or not: algorithms, maths, concepts.",
		"Give a title, why it is worth teaching, a kind (concept, skill, tool or pattern), and evidenceIds: the ids of the notes it rests on.",
		"",
		...sent.map((item) => `[${item.id}] ${clipSnippet(item.textRedacted)}`),
	].join("\n");

	let out: unknown;
	try {
		out = await deps.llm.complete(prompt, DraftSchema);
	} catch {
		return { kind: "skipped", reason: "llm-failed" };
	}
	if (!Value.Check(DraftSchema, out) || out.title.trim() === "" || out.why.trim() === "") {
		return { kind: "skipped", reason: "invalid-output" };
	}
	// A model can invent ids; only ids that were in this prompt count as evidence.
	const sentIds = new Set(sent.map((item) => item.id));
	const evidenceIds = [...new Set(out.evidenceIds.filter((id) => sentIds.has(id)))];
	if (evidenceIds.length === 0) return { kind: "skipped", reason: "invalid-output" };
	return { kind: "draft", draft: { title: out.title, why: out.why, kind: out.kind, evidenceIds } };
}
