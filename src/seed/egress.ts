import type { AllowEgress } from "./types";

export const MAX_SNIPPET_CHARS = 300;

/** Substring and case-insensitive on purpose: a project has many worktree and path variants, so over-blocking is the safe side. */
export function createAllowEgress(optOut: readonly string[]): AllowEgress {
	const blocked = optOut.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== "");
	return (project) => {
		if (project === null) return true;
		const lower = project.toLowerCase();
		return !blocked.some((entry) => lower.includes(entry));
	};
}

export function clipSnippet(redactedText: string): string {
	return redactedText.length <= MAX_SNIPPET_CHARS ? redactedText : redactedText.slice(0, MAX_SNIPPET_CHARS);
}
