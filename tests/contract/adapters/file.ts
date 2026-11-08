/**
 * File-store adapter. shortcut: the upstream file stores are module singletons bound to LH_DATA_DIR at
 * import time, and a fresh import costs ~200 ms (too slow per property run). So the first open() points
 * the env at a stable symlink and fresh-imports the stores once (tsx namespaces each tsImport call, so
 * they are isolated from the rest of the process); every open(dir) re-points that symlink at `dir`.
 * One factory per process. P3 replaces this with directory factories.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tsImport } from "tsx/esm/api";
import type { AdapterFactory, Ledger, StoreBundle } from "../harness.ts";

const root = path.resolve(import.meta.dirname, "../../..");

const slot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lh-file-slot-")), "data");

/** One tsImport of a generated entry module, so every store and the event bus share ONE module instance set. */
async function bind() {
	process.env.LH_DATA_DIR = slot;
	process.env.LH_AUTH_FILE = path.join(slot, "auth.json");
	const mods = { cfg: "config.ts", events: "src/core/events.ts", graph: "src/store/graph.ts", chats: "src/store/chats.ts", jobs: "src/store/jobs.ts", settings: "src/store/settings.ts", sourceOrg: "src/store/source-organization.ts", prompts: "src/store/prompt-overrides.ts", auth: "src/store/auth.ts", render: "src/store/render-settings.ts", contracts: "src/core/contracts/graph.ts" };
	const entry = path.join(path.dirname(slot), "entry.mts");
	fs.writeFileSync(entry, Object.entries(mods).map(([k, rel]) => `export * as ${k} from ${JSON.stringify(path.join(root, rel))};`).join("\n"));
	return (await tsImport(entry, { parentURL: import.meta.url, tsconfig: path.join(root, "tsconfig.json") })) as Record<keyof typeof mods, any>;
}
let bound: ReturnType<typeof bind> | undefined;

const factory: AdapterFactory = {
	name: "file",
	capabilities: { revision: false, corruptLines: false, refusesAtOpen: false },
	async open(dir): Promise<StoreBundle> {
		fs.rmSync(slot, { force: true });
		fs.symlinkSync(dir, slot, "dir");
		const m = await (bound ??= bind());
		const cfg = m.cfg;
		const g = m.graph, o = m;
		const files: Record<Ledger, string> = {
			nodes: cfg.LEDGER_FILES.nodes, chains: cfg.LEDGER_FILES.chains,
			coverage: cfg.LEDGER_FILES.coverage, checkpoints: cfg.LEDGER_FILES.sessions,
		};
		const append = (l: Ledger, s: string) => { fs.mkdirSync(path.dirname(files[l]), { recursive: true }); fs.appendFileSync(files[l], s); };
		return {
			graph: g.graphStore, chats: o.chats.chatStore, jobs: o.jobs.jobStore, settings: o.settings.settingsStore,
			sourceOrg: o.sourceOrg.sourceOrganizationStore, prompts: o.prompts.promptOverrides, auth: o.auth.authStore,
			render: { read: o.render.readRenderSettings, write: o.render.writeRenderSettings },
			events: { subscribe: o.events.subscribe },
			hooks: {
				injectCorruptLine: (l, t) => append(l, `${t}\n`),
				injectTornTail: (l, t) => append(l, t),
				stampNewerFormat: () => { fs.mkdirSync(path.dirname(cfg.GRAPH_FORMAT_FILE), { recursive: true }); fs.writeFileSync(cfg.GRAPH_FORMAT_FILE, JSON.stringify({ version: o.contracts.CURRENT_GRAPH_FORMAT_VERSION + 1 })); },
				clearFormatStamp: () => fs.rmSync(cfg.GRAPH_FORMAT_FILE, { force: true }),
			},
			dispose: () => {},
		};
	},
};
export default factory;
