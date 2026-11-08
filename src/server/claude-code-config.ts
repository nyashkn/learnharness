import { getClaudeBinary } from "../agent/claude-code/binary.ts";
import { settingsStore } from "./stores.ts";

/** Fresh admission state, not a process-wide cache. Existing runs retain
 * their engines; only new chat/job/extraction/compaction admissions consult it. */
export function claudeCodeEnabled(): boolean {
	return settingsStore.readSettings()?.claudeCode?.enabled === true;
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function claudeCodeAvailable(): boolean {
	return claudeCodeEnabled() && getClaudeBinary() !== null;
}
