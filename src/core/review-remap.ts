import type { ReviewLine, ReviewRemap } from "./contracts.ts";

/** The final id `id` follows through `remaps` (a later remap of the same `from` wins). Throws on a cycle (a self-remap is one). */
function resolveId(id: string, next: ReadonlyMap<string, string>): string {
	const seen = new Set<string>([id]);
	let cur = id;
	for (let to = next.get(cur); to !== undefined; to = next.get(cur)) {
		if (seen.has(to)) throw new Error(`review remap cycle: ${[...seen, to].join(" -> ")}`);
		seen.add(to);
		cur = to;
	}
	return cur;
}

const toMap = (remaps: readonly ReviewRemap[]) => new Map(remaps.map((r) => [r.from, r.to]));

/** Throws when appending from -> to to `existing` would make a cycle. */
export function assertNoRemapCycle(existing: readonly ReviewRemap[], from: string, to: string): void {
	resolveId(from, toMap([...existing, { from, to }]));
}

/** The lines with every target resolved to its current id; duplicates the merge creates collapse (first wins). Lines are copied, never mutated. Throws on a cycle. */
export function applyReviewRemaps(lines: ReviewLine[], remaps: readonly ReviewRemap[]): ReviewLine[] {
	if (remaps.length === 0) return lines;
	const next = toMap(remaps);
	for (const from of next.keys()) resolveId(from, next); // a cycle anywhere in the ledger is refused, even if no line touches it
	return lines.map((l) => ({ ...l, targets: [...new Set(l.targets.map((t) => resolveId(t, next)))] }));
}
