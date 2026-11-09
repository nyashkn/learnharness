import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { emptySourceOrganization, parseSourceOrganization } from "../core/source-organization.ts";
import type { GraphStore, SourceOrganizationStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { graphStore, sameOnDisk, txnHooksOf } from "./graph.ts";
import { beforeWrite } from "./marker.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

const PENDING_KEY = "source-organization";

/**
 * A file SourceOrganizationStore over `graphDir`. `graph` is the GraphStore whose transact its writes
 * commit or roll back with (it must come from createGraphStore, or writes are immediate).
 */
export function createSourceOrganizationStore(graphDir: string, graph: GraphStore, opts: { dataDir?: string } = {}): SourceOrganizationStore {
	const dataDir = opts.dataDir ?? path.dirname(path.resolve(graphDir));
	const file = path.join(graphDir, "source-organization.json");
	const formatFile = path.join(graphDir, "format.json");
	const txn = txnHooksOf(graph);
	return {
		read() {
			assertGraphFormat(formatFile);
			const pending = txn?.pendingWrite(PENDING_KEY); // read-your-writes inside GraphStore.transact
			if (pending !== undefined) return parseSourceOrganization(pending);
			let raw: string;
			try { raw = fs.readFileSync(file, "utf8"); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySourceOrganization();
				throw error;
			}
			return parseSourceOrganization(JSON.parse(raw));
		},
		write(state) {
			assertGraphFormat(formatFile);
			const valid = parseSourceOrganization(structuredClone(state)); // a snapshot: later caller mutation must not change what commits
			const commit = () => {
				beforeWrite(dataDir);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				ensureGraphFormat(formatFile);
				const body = JSON.stringify(valid, null, "\t") + "\n";
				if (!sameOnDisk(file, body)) { // an identical write must not move revision()
					const write = () => writeFileAtomicSync(file, body);
					if (txn) txn.stamped(file, write); else write();
				}
				removeLeftoverTemps(file); // crash leftovers could still place deleted sources
			};
			const announce = () => emit("sources-changed", {});
			// Inside GraphStore.transact the write waits for commit and the event for the whole commit.
			if (txn?.deferWrite(PENDING_KEY, valid, commit, announce)) return;
			commit();
			announce();
		},
	};
}

/** The app's instance: the same graph store src/server/stores.ts wires, so one transact covers both. */
export const sourceOrganizationStore: SourceOrganizationStore = createSourceOrganizationStore(PATHS.graph, graphStore, { dataDir: PATHS.data });
