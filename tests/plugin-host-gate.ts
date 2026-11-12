import * as path from "node:path";
import { beforeWrite } from "../src/store/marker.ts";
import { safePluginDataDirectory } from "../src/store/plugin-data-paths.ts";

/** Test wiring for PluginHostDependencies: the data folder is the plugins directory's parent (where plugins-state.json lives),
 * so the real marker + store lock run on the test's own throwaway folder, exactly as plugins.ts wires them over PATHS.data. */
export function pluginHostGate(pluginsDirectory: string) {
	const dataDir = path.dirname(path.resolve(pluginsDirectory));
	return {
		dataDirectoryFor: (community: string, id: string, core?: { directory: string; ids: readonly string[] }, create?: boolean) =>
			safePluginDataDirectory(community, id, core, create ? { dataDir } : undefined),
		beforeWrite: () => { beforeWrite(dataDir); },
	};
}
