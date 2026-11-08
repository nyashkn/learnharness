// Order matters: whole-token rules run before URL and email rules so a secret inside a URL is gone either way.
// Lookbehinds use [A-Za-z0-9] (not \b) so `_` and `-` before a token do not hide it.
const NOT_ALNUM = "(?<![A-Za-z0-9])";

// The optional BLOCK covers PGP ("PRIVATE KEY BLOCK"); an unterminated block is cut to the end of text, the safe side.
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
const TOKENS: readonly RegExp[] = [
	/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, // JWT
	new RegExp(`${NOT_ALNUM}sk-[A-Za-z0-9_-]{16,}`, "g"), // sk-, sk-ant-, sk-or-
	new RegExp(`${NOT_ALNUM}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, "g"),
	new RegExp(`${NOT_ALNUM}(?:AKIA|ASIA)[A-Z0-9]{16}`, "g"),
	new RegExp(`${NOT_ALNUM}xox[abprs]-[A-Za-z0-9-]{10,}`, "g"),
	// Minimum lengths sit above ordinary words: fc-barcelona and st.louis survive.
	new RegExp(`${NOT_ALNUM}(?:pplx-[A-Za-z0-9]{20,}|tvly-[A-Za-z0-9_-]{16,}|fc-[A-Za-z0-9]{24,}|xai-[A-Za-z0-9]{20,})`, "g"),
	new RegExp(`${NOT_ALNUM}(?:gsk_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|phx_[A-Za-z0-9]{20,})`, "g"),
	new RegExp(`${NOT_ALNUM}(?:(?:pk|sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|pk_[A-Za-z0-9]{24,}|AIza[A-Za-z0-9_-]{30,}|st\\.[A-Za-z0-9_-]{32,}|xapp-[A-Za-z0-9-]{10,})`, "g"),
];
// Header names that carry credentials; the value runs to the end of the line or the closing quote.
const HEADER =
	/(?<![A-Za-z0-9-])((?:X-[A-Za-z0-9-]*(?:Token|Key|Secret|Auth|Password)|Proxy-Authorization|Authorization|Set-Cookie|Cookie)["']?[ \t]*:[ \t]*)(?:"[^"\n]*"|'[^'\n]*'|[^\n"']*)/gi;
const PATH_SECRET_URL =
	/(?:[a-z][a-z0-9+.-]*:\/\/)?(?:hooks\.slack\.com\/services\/|discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/|api\.telegram\.org\/(?:file\/)?bot)[^\s"'<>]+/gi;
const INLINE_ENV = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]+[ \t]*=(?![=>])[ \t]*)(?!\[redacted:)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g;
const KEY_VALUE =
	/(?<![A-Za-z0-9])([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|credentials?)["']?[ \t]*[:=][ \t]*)(?!\[redacted:)(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;&)}\]]+)/gi;
// Alnum-only runs: hex digests and similar; the digit+letter test keeps long identifiers out.
const OPAQUE_RUN = /(?<![A-Za-z0-9])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ENV_LINE = /^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]+)=[^\n]*/gm;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SPLIT_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Measured: slugs and hyphenated English sit below this, random base64url above it.
const MIN_ENTROPY = 4.4;

function entropy(run: string): number {
	const counts = new Map<string, number>();
	for (const c of run) counts.set(c, (counts.get(c) ?? 0) + 1);
	let h = 0;
	for (const n of counts.values()) h -= (n / run.length) * Math.log2(n / run.length);
	return h;
}

/** Tokens split by "-" or "_" escape the alnum rule; entropy tells them from slugs and compounds. */
function redactSplitRun(run: string): string {
	return /\d/.test(run) && !UUID.test(run) && entropy(run) >= MIN_ENTROPY ? "[redacted:secret]" : run;
}
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
	out = out.replace(HEADER, "$1[redacted:header]");
	out = out.replace(PATH_SECRET_URL, "[redacted:url]");
	// A "#" fragment holding key=value is an OAuth-style token carrier; bare anchors like #L10 stay.
	out = out.replace(URL_RE, (url) => (/[?]|#[^#\s]*=|\/\/[^/]*@/.test(url) ? "[redacted:url]" : url));
	out = out.replace(ENV_LINE, "$1=[redacted:env]");
	out = out.replace(INLINE_ENV, "$1[redacted:env]");
	out = out.replace(KEY_VALUE, "$1[redacted:secret]");
	out = out.replace(OPAQUE_RUN, "[redacted:secret]");
	out = out.replace(SPLIT_RUN, redactSplitRun);
	out = out.replace(EMAIL, "[redacted:email]");
	for (const re of HOME_PATHS) out = out.replace(re, "~");
	return out;
}
