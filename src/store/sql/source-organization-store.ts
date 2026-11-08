/**
 * SourceOrganizationStore on the graph store's SQL core (architecture 4.1: `documents` row 'source-organization').
 * Factory only. The write joins an open GraphStore.transact: it and its event wait for COMMIT; outside one it
 * wraps itself in `auto:sourceOrg.write`. It seals (the working set changed) but does not move
 * GraphStore.revision(), which covers the four ledgers and the sources map only (the file adapter's
 * revision stats the same files and not source-organization.json).
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
					core.changed({ revision: false });
				}
				core.afterCommit(() => emit("sources-changed", {}));
			});
		},
	} satisfies SourceOrganizationStore;
}
