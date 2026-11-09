/**
 * SourceOrganizationStore on the graph store's SQL core (architecture 4.1: `documents` row 'source-organization').
 * Factory only. The write joins an open GraphStore.transact: it and its event wait for COMMIT; outside one it
 * wraps itself in `auto:sourceOrg.write`. A write that changes the row seals and moves GraphStore.revision()
 * (architecture 2.1 items 9 and 16); an identical write does neither.
 */
import { emptySourceOrganization, parseSourceOrganization } from "../../core/source-organization.ts";
import type { SourceOrganizationStore } from "../../core/ports.ts";
import type { GraphCore } from "./graph-store";

const KEY = "source-organization";

export interface SourceOrganizationOptions {
	core: GraphCore;
	/** Called once per committed write, after COMMIT and seal. */
	emit: (event: "sources-changed", payload: Record<string, never>) => void;
}

export function createSourceOrganizationStore({ core, emit }: SourceOrganizationOptions): SourceOrganizationStore {
	const { db } = core;
	return {
		read() {
			core.guard();
			const row = db.get<{ json: string }>("SELECT json FROM documents WHERE key = ?", KEY);
			return row ? parseSourceOrganization(JSON.parse(row.json)) : emptySourceOrganization();
		},
		write(state) {
			core.guard();
			const valid = parseSourceOrganization(structuredClone(state)); // a snapshot: later caller mutation must not change what commits
			const text = JSON.stringify(valid);
			core.bare("auto:sourceOrg.write", () => {
				const prev = db.get<{ json: string }>("SELECT json FROM documents WHERE key = ?", KEY);
				if (prev?.json !== text && db.run("INSERT INTO documents (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json", KEY, text).changes > 0) {
					core.changed();
				}
				core.afterCommit(() => emit("sources-changed", {}));
			});
		},
	} satisfies SourceOrganizationStore;
}
