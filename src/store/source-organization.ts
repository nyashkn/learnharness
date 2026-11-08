import fs from "node:fs";
import path from "node:path";
import { SOURCE_ORGANIZATION_FILE } from "../../config.ts";
import { emptySourceOrganization, parseSourceOrganization } from "../core/source-organization.ts";
import type { SourceOrganizationStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { deferWrite, pendingWrite } from "./graph.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

const PENDING_KEY = "source-organization";

export const sourceOrganizationStore: SourceOrganizationStore = {
	read() {
		assertGraphFormat();
		const pending = pendingWrite(PENDING_KEY); // read-your-writes inside GraphStore.transact
		if (pending !== undefined) return parseSourceOrganization(pending);
		let raw: string;
		try { raw = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySourceOrganization();
			throw error;
		}
		return parseSourceOrganization(JSON.parse(raw));
	},
	write(state) {
		assertGraphFormat();
		const valid = parseSourceOrganization(state);
		const commit = () => {
			fs.mkdirSync(path.dirname(SOURCE_ORGANIZATION_FILE), { recursive: true });
			ensureGraphFormat();
			writeFileAtomicSync(SOURCE_ORGANIZATION_FILE, JSON.stringify(valid, null, "\t") + "\n");
			removeLeftoverTemps(SOURCE_ORGANIZATION_FILE); // crash leftovers could still place deleted sources
			emit("sources-changed", {}); // after the write, and after the graph transaction commits
		};
		// Inside GraphStore.transact the write and its event wait for commit.
		if (!deferWrite(PENDING_KEY, valid, commit)) commit();
	},
};
