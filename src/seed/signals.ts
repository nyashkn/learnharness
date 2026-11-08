import type { Signal } from "./types";

const CONFUSION =
	/\?\?|\beli5\b|\bexplain\b|\bwhy (?:does|do|is|are|would)\b|\bwhat(?:'s| is| are) an?\b|\bi (?:don't|dont|do not) (?:understand|get)\b|\bconfus|\b(?:let me rephrase|what i mean(?: is)?|i meant)\b/i;
const DECISION = /\b(?:should (?:i|we)|which (?:one|is better|should)|vs\.?|versus|choose between|pros and cons|trade-?offs?)\b/i;
const DELEGATED = /\b(?:just (?:do|make|fix|write|implement|build|handle)|do it for me|you decide|go ahead and|take care of (?:it|this)|handle (?:it|this))\b/i;

/** First match wins: confusion > decision > delegated. */
export function tagSignal(text: string): Signal {
	if (CONFUSION.test(text)) return "confusion";
	if (DECISION.test(text)) return "decision";
	if (DELEGATED.test(text)) return "delegated";
	return null;
}

const normalise = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Ids whose normalised text occurs in `minSessions` or more distinct sessions. The caller decides what 'repeat' overrides. */
export function findRepeats(
	items: readonly { id: string; sessionId: string | null; text: string }[],
	minSessions = 3,
): Set<string> {
	const byText = new Map<string, { sessions: Set<string>; ids: string[] }>();
	for (const item of items) {
		const key = normalise(item.text);
		if (key === "" || item.sessionId === null) continue;
		const group = byText.get(key) ?? { sessions: new Set(), ids: [] };
		group.sessions.add(item.sessionId);
		group.ids.push(item.id);
		byText.set(key, group);
	}
	const repeated = new Set<string>();
	for (const group of byText.values()) if (group.sessions.size >= minSessions) for (const id of group.ids) repeated.add(id);
	return repeated;
}
