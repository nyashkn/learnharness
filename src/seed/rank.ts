export interface RankInput {
	/** Learning gap from the judge; null means the judge gave no decision. */
	gap: number | null;
	nItems: number;
	nProjects: number;
	daysSinceLast: number;
	/** From rerank; null means no decision. */
	goalRelevance: number | null;
}

/** Both are calibrated on owner labels (about 70), so code carries no default. */
export interface RankConfig {
	recencyHalfLifeDays: number;
	goalWeight: number;
}

export interface RankDimensions {
	gap: number;
	items: number;
	spread: number;
	recency: number;
	goal: number;
}

export type RankResult = { kind: "ranked"; score: number; dimensions: RankDimensions } | { kind: "review"; reason: string };

/** rank = gap × log1p(nItems) × (1 + 0.5 × [nProjects ≥ 2]) × recency × (1 + goalWeight × goalRelevance). A missing judgment goes to review, never scored as 0. */
export function rankProposal(input: RankInput, config: RankConfig): RankResult {
	if (input.gap === null || !Number.isFinite(input.gap)) return { kind: "review", reason: "no gap judgment" };
	if (input.goalRelevance === null || !Number.isFinite(input.goalRelevance)) return { kind: "review", reason: "no goal relevance judgment" };
	if (!(config.recencyHalfLifeDays > 0) || !Number.isFinite(config.goalWeight)) throw new RangeError("rank config needs recencyHalfLifeDays > 0 and a finite goalWeight");

	const dimensions: RankDimensions = {
		gap: input.gap,
		items: Math.log1p(input.nItems),
		spread: 1 + 0.5 * (input.nProjects >= 2 ? 1 : 0),
		recency: 0.5 ** (Math.max(0, input.daysSinceLast) / config.recencyHalfLifeDays),
		goal: 1 + config.goalWeight * input.goalRelevance,
	};
	return { kind: "ranked", score: dimensions.gap * dimensions.items * dimensions.spread * dimensions.recency * dimensions.goal, dimensions };
}
