import { redact } from "./redact";
import type { AllowEgress } from "./types";

export const MAX_SNIPPET_CHARS = 300;

const flatten = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");

/**
 * One spelling for entry and project: the stored project is already redacted (`~/work/x`, or the omp slug `~-work-x`),
 * so a raw path or `client_x` entry would never match without the same redact-then-flatten on both sides.
 */
export function canonProject(s: string): string {
	return flatten(redact(s));
}

/**
 * The form an opt-out entry is matched against, or null when the project carries no usable provenance: none given,
 * nothing left after flattening, or redaction replaced part of it (a swallowed slug matches no entry, so it would fail open).
 * The placeholder test and the match use the same redacted string, because redact is not idempotent on every slug.
 */
export function matchableProject(project: string | null): string | null {
	if (project === null) return null;
	const redacted = redact(project);
	if (redacted.includes("[redacted:")) return null;
	const canon = flatten(redacted);
	return canon === "" ? null : canon;
}

/** Substring on purpose: a project has many worktree and path variants, so over-blocking is the safe side. No provenance counts as null. */
export function createAllowEgress(optOut: readonly string[]): AllowEgress {
	const blocked = optOut.map(canonProject).filter((entry) => entry !== "");
	return (project) => {
		const canon = matchableProject(project);
		return canon === null || !blocked.some((entry) => canon.includes(entry));
	};
}

export function clipSnippet(redactedText: string): string {
	return redactedText.length <= MAX_SNIPPET_CHARS ? redactedText : redactedText.slice(0, MAX_SNIPPET_CHARS);
}
