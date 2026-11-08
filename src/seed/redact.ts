// Order matters: whole-token rules run before URL and email rules so a secret inside a URL is gone either way.
// Lookbehinds use [A-Za-z0-9] (not \b) so `_` and `-` before a token do not hide it.
const NOT_ALNUM = "(?<![A-Za-z0-9])";

const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const TOKENS: readonly RegExp[] = [
	/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, // JWT
	new RegExp(`${NOT_ALNUM}sk-[A-Za-z0-9_-]{16,}`, "g"), // sk-, sk-ant-, sk-or-
	new RegExp(`${NOT_ALNUM}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, "g"),
	new RegExp(`${NOT_ALNUM}(?:AKIA|ASIA)[A-Z0-9]{16}`, "g"),
	new RegExp(`${NOT_ALNUM}xox[abprs]-[A-Za-z0-9-]{10,}`, "g"),
];
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ENV_LINE = /^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]+)=[^\n]*/gm;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HOME_PATHS: readonly RegExp[] = [
	/\/(?:Users|home)\/[^/\s]+/g,
	/[A-Za-z]:\\Users\\[^\\\s]+/g,
	// shortcut: a slug can't show where a hyphenated username ends, so its tail survives; inject the real home slug if one appears.
	new RegExp(`${NOT_ALNUM}-(?:Users|home)-[^-\\s/]+`, "g"), // cwd slug form
];

/** Pure and idempotent: placeholders never match any rule. Always on; there is no switch. */
export function redact(text: string): string {
	let out = text.replace(PEM, "[redacted:key]");
	for (const re of TOKENS) out = out.replace(re, "[redacted:secret]");
	out = out.replace(BEARER, "Bearer [redacted:token]");
	out = out.replace(ENV_LINE, "$1=[redacted:env]");
	out = out.replace(URL_RE, (url) => (/[?]|\/\/[^/]*@/.test(url) ? "[redacted:url]" : url));
	out = out.replace(EMAIL, "[redacted:email]");
	for (const re of HOME_PATHS) out = out.replace(re, "~");
	return out;
}
