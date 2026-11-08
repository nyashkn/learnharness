import { redact } from "../redact";
import { tagSignal } from "../signals";
import type { HarvestItem, SessionSource } from "../types";
import { sha256 } from "./shared";

/** The only path from RawItem to HarvestItem: redaction cannot be bypassed by a source. */
export async function* harvest(sources: readonly SessionSource[]): AsyncIterable<HarvestItem> {
	for (const source of sources) {
		for await (const raw of source.items()) {
			const textRedacted = redact(raw.text);
			yield {
				id: sha256(raw.source + raw.nativeId),
				source: raw.source,
				project: raw.project === null ? null : redact(raw.project),
				sessionId: raw.sessionId === null ? null : redact(raw.sessionId),
				at: raw.at,
				signal: tagSignal(textRedacted),
				textRedacted,
			};
		}
	}
}
