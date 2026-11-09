/**
 * A stable per-user machine id for the store lock's `host` field.
 * os.hostname() changes with the network on macOS, which made a leftover lock look like another machine's.
 * The id is a random UUID kept in `~/.learnharness/machine-id`, outside the data folder. Read once per process.
 * Falls back to os.hostname() when the file cannot be read or written, or is empty.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Uncached, for tests. Two racing creators agree: the file is published whole with link(2), the loser reads it back. */
export function loadMachineId(home: string = os.homedir()): string {
	const file = path.join(home, ".learnharness", "machine-id");
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temp = `${file}.${randomUUID()}.tmp`;
		fs.writeFileSync(temp, `${randomUUID()}\n`, { flag: "wx" });
		try {
			fs.linkSync(temp, file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		} finally {
			fs.rmSync(temp, { force: true });
		}
		const id = fs.readFileSync(file, "utf8").trim();
		if (id !== "") return id;
	} catch {
		// fall through to the hostname
	}
	return os.hostname();
}

let cached: string | undefined;
export const machineId = (): string => (cached ??= loadMachineId());
