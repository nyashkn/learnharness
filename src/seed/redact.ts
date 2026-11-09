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
// CLI credential flags: KEY_VALUE only sees "=", and a flag also takes its value after whitespace. `--token-count 5` stays.
const FLAG = /(?<![A-Za-z0-9-])(--(?:password|passwd|token|api-key|apikey|secret|auth-token|access-token)(?:=|[ \t]+))(?!\[redacted:)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi;
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

// ---- tokens wrapped across a line ----
// Each line fragment of a wrapped token is too short for any rule, so a run that ends a line is joined to the run that
// starts the next and the joined view is scanned with the same rules.
const RUN = "[A-Za-z0-9_.-]";
// Before the break: trailing blanks or a right border (" │"). The break: CRLF, LF or CR, exactly one, so a blank line,
// form feed, U+2028, U+2029 or NEL never joins. After it: indentation (NBSP too) and quote, box, table, comment or diff prefixes.
const WRAP_SEP = "[ \\t\\u00a0]*(?:[│┃║|][ \\t\\u00a0]*)?(?:\\r\\n?|\\n)[ \\t\\u00a0]*(?:(?:[>│┃║|#+*]|//)[ \\t\\u00a0]*)*";
const WRAP_CHAIN = new RegExp(`(?<!${RUN})${RUN}+(?:${WRAP_SEP}${RUN}+)+`, "g");
const WRAP_SPLIT = new RegExp(`(${WRAP_SEP})`);
// A plain word of 5 or more letters is prose, not a token fragment.
const PLAIN_WORD = /^(?:[a-z]{5,}|[A-Z][a-z]{4,}|[A-Z]{5,})$/;
// shortcut: a joined group stops at this length, so a token straddling the cut in a longer pasted blob can leak a fragment; raise it if blobs matter.
const MAX_JOIN = 4096;

type Span = readonly [start: number, end: number];

/** Where the run-level rules would redact `s`, measured on `s` itself rather than after earlier replacements. */
function runSpans(s: string): Span[] {
	const spans: Span[] = [];
	for (const re of TOKENS) for (const m of s.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
	for (const m of s.matchAll(OPAQUE_RUN)) spans.push([m.index, m.index + m[0].length]);
	for (const m of s.matchAll(SPLIT_RUN)) if (redactSplitRun(m[0]) !== m[0]) spans.push([m.index, m.index + m[0].length]);
	return spans;
}

const crosses = (spans: readonly Span[], cut: number) => spans.some(([start, end]) => start < cut && cut < end);

function joinable(left: string, right: string): boolean {
	// one cwd slug per line is a list, not a wrapped token
	if (left.startsWith("-") && right.startsWith("-")) return false;
	if (!PLAIN_WORD.test(left) && !PLAIN_WORD.test(right)) return true;
	// next to a plain word, only a named token rule running across the break joins
	const joined = left + right;
	return TOKENS.some((re) => crosses([...joined.matchAll(re)].map((m) => [m.index, m.index + m[0].length] as const), left.length));
}

/** `group` alternates fragment, separator, fragment. Redacts the joined view only when a rule runs across a break. */
function redactGroup(group: readonly string[]): string {
	if (group.length === 1) return group[0]!;
	const frags = group.filter((_, i) => i % 2 === 0);
	const joined = frags.join("");
	const cuts: number[] = [];
	for (let k = 0, at = 0; k < frags.length - 1; k++) cuts.push((at += frags[k]!.length));
	const spans = runSpans(joined);
	if (!cuts.some((cut) => crosses(spans, cut))) return group.join("");
	const covered = new Uint8Array(joined.length);
	for (const [start, end] of spans) covered.fill(1, start, end);
	for (let k = 0, at = 0; k < frags.length; at += frags[k]!.length, k++) {
		for (const [start, end] of runSpans(frags[k]!)) covered.fill(1, at + start, at + end);
	}
	let out = "";
	for (let k = 0, at = 0; k < frags.length; k++) {
		// a break inside a redaction goes with it; any other break stays where it was
		if (k > 0 && !(covered[at - 1] && covered[at])) out += group[2 * k - 1];
		for (const ch of frags[k]!) {
			if (!covered[at]) out += ch;
			else if (at === 0 || !covered[at - 1]) out += "[redacted:secret]";
			at++;
		}
	}
	return out;
}

function redactWrapped(chain: string): string {
	const parts = chain.split(WRAP_SPLIT);
	let out = "";
	let group = [parts[0]!];
	let length = parts[0]!.length;
	for (let i = 1; i < parts.length; i += 2) {
		const sep = parts[i]!;
		const next = parts[i + 1]!;
		if (joinable(group[group.length - 1]!, next) && length + next.length <= MAX_JOIN) {
			group.push(sep, next);
			length += next.length;
		} else {
			out += redactGroup(group) + sep;
			group = [next];
			length = next.length;
		}
	}
	return out + redactGroup(group);
}

/** Pure and idempotent: placeholders never match any rule. Always on; there is no switch. */
export function redact(text: string): string {
	let out = text.replace(PEM, "[redacted:key]");
	out = out.replace(WRAP_CHAIN, redactWrapped);
	for (const re of TOKENS) out = out.replace(re, "[redacted:secret]");
	out = out.replace(BEARER, "Bearer [redacted:token]");
	out = out.replace(HEADER, "$1[redacted:header]");
	out = out.replace(PATH_SECRET_URL, "[redacted:url]");
	// A "#" fragment holding key=value is an OAuth-style token carrier; bare anchors like #L10 stay.
	out = out.replace(URL_RE, (url) => (/[?]|#[^#\s]*=|\/\/[^/]*@/.test(url) ? "[redacted:url]" : url));
	out = out.replace(ENV_LINE, "$1=[redacted:env]");
	out = out.replace(INLINE_ENV, "$1[redacted:env]");
	out = out.replace(FLAG, "$1[redacted:secret]");
	out = out.replace(KEY_VALUE, "$1[redacted:secret]");
	// SPLIT_RUN first: OPAQUE_RUN would replace an alnum stretch inside a dashed token and leave pieces too short for SPLIT_RUN.
	out = out.replace(SPLIT_RUN, redactSplitRun);
	out = out.replace(OPAQUE_RUN, "[redacted:secret]");
	out = out.replace(EMAIL, "[redacted:email]");
	for (const re of HOME_PATHS) out = out.replace(re, "~");
	return out;
}
