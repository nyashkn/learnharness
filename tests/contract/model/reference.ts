/**
 * Reference model for the model-based suite (lh-o0a). An in-memory GraphStore written on purpose in a
 * different style from src/store/graph.ts: no op log, no files. A transaction works on a deep copy and the
 * copy replaces the live state on success; a failed one just drops the copy. Imports types only.
 */
import type { CoverageEntry, GraphChain, GraphNode, Position, SessionCheckpoint } from "../../../src/core/contracts.ts";

export interface Ledgers {
	nodes: GraphNode[];
	chains: GraphChain[];
	coverage: CoverageEntry[];
	checkpoints: SessionCheckpoint[];
}

/** A rewrite request: per ledger, which lines to keep (mask cycles over the lines), whether to reverse, whether to modify the kept copies. */
export interface RewriteSpec {
	nodes?: Mask;
	chains?: Mask;
	coverage?: Mask;
	checkpoints?: Mask;
}
export interface Mask { keep: boolean[]; rev: boolean; mod: boolean }

export const emptyLedgers = (): Ledgers => ({ nodes: [], chains: [], coverage: [], checkpoints: [] });
export const cloneLedgers = (l: Ledgers): Ledgers => structuredClone(l);

/** A modified COPY of a line: same identity, different payload. */
const modifiers: { [K in keyof Ledgers]: (x: Ledgers[K][number]) => Ledgers[K][number] } = {
	nodes: (n) => ({ ...n, statement: `${n.statement}!`, aliases: [...n.aliases, "mod"] }),
	chains: (c) => ({ ...c, createdAt: "2026-02-02T00:00:00.000Z", provenance: [...c.provenance, { chatId: "c1", messageId: "mod" }] }),
	coverage: (e) => ({ ...e, tokens: e.tokens + 1 }),
	checkpoints: (e) => ({ ...e, foldedAt: "2026-02-02T00:00:00.000Z" }),
};

/** Turn a RewriteSpec into concrete arrays against the CURRENT lines (the model's, never the store's). */
export function resolveRewrite(cur: Ledgers, spec: RewriteSpec): Partial<Ledgers> {
	const out: Record<string, unknown[]> = {};
	for (const k of Object.keys(modifiers) as (keyof Ledgers)[]) {
		const m = spec[k];
		if (!m) continue;
		let lines = (cur[k] as unknown[]).filter((_, i) => m.keep[i % m.keep.length]);
		if (m.rev) lines = [...lines].reverse();
		out[k] = lines.map((x) => structuredClone(m.mod ? (modifiers[k] as (x: unknown) => unknown)(x) : x));
	}
	return out as Partial<Ledgers>;
}

export class Model {
	led: Ledgers = emptyLedgers();
	positions: Record<string, Position> = {};
	/** The value render.write returned last (settings live outside transact). */
	render: unknown = null;

	append<K extends keyof Ledgers>(k: K, line: Ledgers[K][number]): void { (this.led[k] as unknown[]).push(structuredClone(line)); }
	rewrite(next: Partial<Ledgers>): void { for (const k of Object.keys(next) as (keyof Ledgers)[]) this.led[k] = structuredClone(next[k]) as never; }

	/** Observable state, normalised for comparison. Line order matters (the first line defines). */
	snapshot(): string {
		const pos = Object.fromEntries(Object.entries(this.positions).sort(([a], [b]) => a.localeCompare(b)));
		return JSON.stringify([this.led.nodes, this.led.chains, this.led.coverage, this.led.checkpoints, pos, this.render]);
	}
}
