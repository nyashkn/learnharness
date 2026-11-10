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

/** True when an opt-out entry can never match a project: nothing is left after flattening, or redaction swallowed it (see matchableProject). */
export function blocksNothing(entry: string): boolean {
	return canonProject(entry) === "" || redact(entry).includes("[redacted:");
}

/** Substring on purpose: a project has many worktree and path variants, so over-blocking is the safe side. No provenance counts as null. */
export function createAllowEgress(optOut: readonly string[]): AllowEgress {
	const blocked = optOut.filter((entry) => !blocksNothing(entry)).map(canonProject);
	return (project) => {
		const canon = matchableProject(project);
		return canon === null || !blocked.some((entry) => canon.includes(entry));
	};
}

/**
 * Default-on egress holds with an empty opt-out list. With any entry, a project with no usable provenance is refused:
 * Signet entities, cwd-less rows and slugs that redaction swallowed cannot be proven not to be opted-out work.
 */
export function composeAllowEgress(optOut: readonly string[]): AllowEgress {
	const inner = createAllowEgress(optOut);
	const listed = optOut.some((entry) => canonProject(entry) !== "");
	return (project) => (matchableProject(project) === null ? !listed : inner(project));
}

export function parseOptOut(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

/** ENOENT is an empty list; any other failure propagates, because a list we could not read must not mean "allow all". */
export async function readOptOut(file: string, read: (file: string) => Promise<string>): Promise<string[]> {
	try {
		return parseOptOut(await read(file));
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw error;
	}
}

export function clipSnippet(redactedText: string): string {
	return redactedText.length <= MAX_SNIPPET_CHARS ? redactedText : redactedText.slice(0, MAX_SNIPPET_CHARS);
}
