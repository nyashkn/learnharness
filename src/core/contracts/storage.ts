/** A data folder or store stamped by a NEWER build than this one (ADR 0009, architecture item 5). Pure: lives in core so SQL and file adapters share it without pulling in config. */
export class StorageVersionError extends Error {
	override name = "StorageVersionError";
	constructor(readonly file: string, readonly found: number, readonly supported: number, kind: "graph format" | "storage layout" = "graph format") {
		super(
			kind === "graph format"
				? `Graph data is stamped with format version ${found}, but this build understands only ${supported}. ` +
						"The app is older than its data — upgrade the app before touching the knowledge map."
				: `${file}: the data folder uses storage layout ${found}, but this build understands only ${supported}. ` +
						"The app is older than its data — upgrade the app before opening this folder.",
		);
	}
}
