export interface Edge {
	from: string;
	to: string;
	/** P(from must come before to). */
	p: number;
}

/** from-before-to order. Among ready nodes the higher priority goes first. Nodes stuck in a leftover cycle still come out, by priority. */
export function topoOrder(ids: readonly string[], edges: readonly Edge[], priority: ReadonlyMap<string, number>): string[] {
	const remaining = new Set(ids);
	const live = edges.filter((e) => remaining.has(e.from) && remaining.has(e.to) && e.from !== e.to);
	const rank = (id: string) => priority.get(id) ?? Number.NEGATIVE_INFINITY;
	const best = (pool: string[]) => pool.reduce((m, id) => (rank(id) > rank(m) || (rank(id) === rank(m) && id < m) ? id : m));
	const order: string[] = [];
	while (remaining.size > 0) {
		const ready = [...remaining].filter((id) => !live.some((e) => e.to === id && remaining.has(e.from)));
		const next = best(ready.length > 0 ? ready : [...remaining]);
		remaining.delete(next);
		order.push(next);
	}
	return order;
}
