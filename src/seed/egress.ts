import { redact } from "./redact";
import type { AllowEgress } from "./types";

export const MAX_SNIPPET_CHARS = 300;

/**
 * One spelling for entry and project: the stored project is already redacted (`~/work/x`, or the omp slug `~-work-x`),
 * so a raw path or `client_x` entry would never match without the same redact-then-flatten on both sides.
 */
export function canonProject(s: string): string {
	return redact(s).normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

/** Substring on purpose: a project has many worktree and path variants, so over-blocking is the safe side. A blank project counts as null. */
export function createAllowEgress(optOut: readonly string[]): AllowEgress {
	const blocked = optOut.map(canonProject).filter((entry) => entry !== "");
	return (project) => {
		if (project === null) return true;
		const canon = canonProject(project);
		if (canon === "") return true;
		return !blocked.some((entry) => canon.includes(entry));
	};
}

export function clipSnippet(redactedText: string): string {
	return redactedText.length <= MAX_SNIPPET_CHARS ? redactedText : redactedText.slice(0, MAX_SNIPPET_CHARS);
}
