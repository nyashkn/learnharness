/**
 * File-store adapter: the production file stores, built by their directory factories over the
 * folder the harness hands in. No symlink, no fresh import, no env: every open(dir) is its own set.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../../../src/core/contracts/graph.ts";
import { subscribe } from "../../../src/core/events.ts";
import { createFileStores } from "../../../src/store/file-stores.ts";
import { graphPaths } from "../../../src/store/graph.ts";
import { releaseStoreLock } from "../../../src/store/marker.ts";
import type { AdapterFactory, AnyLedger, StoreBundle } from "../harness.ts";

const factory: AdapterFactory = {
	name: "file",
	capabilities: { revision: true, corruptLines: true, refusesAtOpen: true, commits: false },
	async open(dir): Promise<StoreBundle> {
		const s = createFileStores(dir, path.join(dir, "auth.json")); // opens: refuses a newer folder
		const g = graphPaths(path.join(dir, "graph"));
		const files: Record<AnyLedger, string> = { nodes: g.nodes, chains: g.chains, coverage: g.coverage, checkpoints: g.sessions, reviews: g.reviews, reviewRemaps: g.reviewRemaps };
		const append = (l: AnyLedger, text: string) => { fs.mkdirSync(path.dirname(files[l]), { recursive: true }); fs.appendFileSync(files[l], text); };
		return {
			graph: s.graphStore, chats: s.chatStore, jobs: s.jobStore, settings: s.settingsStore,
			sourceOrg: s.sourceOrganizationStore, prompts: s.promptOverrides, auth: s.authStore,
			render: { read: () => s.renderSettingsStore.readRenderSettings(), write: (raw) => s.renderSettingsStore.writeRenderSettings(raw) },
			events: { subscribe },
			hooks: {
				injectCorruptLine: (l, t) => append(l, `${t}\n`),
				injectTornTail: (l, t) => append(l, t),
				stampNewerFormat: () => { fs.mkdirSync(path.dirname(g.format), { recursive: true }); fs.writeFileSync(g.format, JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION + 1 })); },
				clearFormatStamp: () => fs.rmSync(g.format, { force: true }),
			},
			dispose: () => releaseStoreLock(dir),
		};
	},
};
export default factory;
