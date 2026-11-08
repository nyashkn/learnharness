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
const load = <T = any>(rel: string) => tsImport(path.join(root, rel), { parentURL: import.meta.url }) as Promise<T>;

const slot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lh-file-slot-")), "data");

async function bind() {
	process.env.LH_DATA_DIR = slot;
	process.env.LH_AUTH_FILE = path.join(slot, "auth.json");
	const cfg = await load("config.ts");
	return {
		cfg,
		...(await load("src/store/graph.ts")),
		...(await load("src/store/chats.ts")),
		...(await load("src/store/jobs.ts")),
		...(await load("src/store/settings.ts")),
		...(await load("src/store/source-organization.ts")),
		...(await load("src/store/prompt-overrides.ts")),
		...(await load("src/store/auth.ts")),
		...(await load("src/store/render-settings.ts")),
		...(await load("src/core/contracts/graph.ts")),
	};
}
let bound: ReturnType<typeof bind> | undefined;

const factory: AdapterFactory = {
	name: "file",
	capabilities: { transact: false },
	async open(dir): Promise<StoreBundle> {
		fs.rmSync(slot, { force: true });
		fs.symlinkSync(dir, slot, "dir");
		const m = await (bound ??= bind());
		const cfg = m.cfg;
		const files: Record<Ledger, string> = {
			nodes: cfg.LEDGER_FILES.nodes, chains: cfg.LEDGER_FILES.chains,
			coverage: cfg.LEDGER_FILES.coverage, checkpoints: cfg.LEDGER_FILES.sessions,
		};
		const append = (l: Ledger, s: string) => { fs.mkdirSync(path.dirname(files[l]), { recursive: true }); fs.appendFileSync(files[l], s); };
		return {
			graph: m.graphStore, chats: m.chatStore, jobs: m.jobStore, settings: m.settingsStore,
			sourceOrg: m.sourceOrganizationStore, prompts: m.promptOverrides, auth: m.authStore,
			render: { read: m.readRenderSettings, write: m.writeRenderSettings },
			hooks: {
				injectCorruptLine: (l, t) => append(l, `${t}\n`),
				injectTornTail: (l, t) => append(l, t),
				stampNewerFormat: () => { fs.mkdirSync(path.dirname(cfg.GRAPH_FORMAT_FILE), { recursive: true }); fs.writeFileSync(cfg.GRAPH_FORMAT_FILE, JSON.stringify({ version: m.CURRENT_GRAPH_FORMAT_VERSION + 1 })); },
				clearFormatStamp: () => fs.rmSync(cfg.GRAPH_FORMAT_FILE, { force: true }),
			},
			dispose: () => {},
		};
	},
};
export default factory;
