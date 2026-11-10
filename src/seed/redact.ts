// Order matters: whole-token rules run before URL and email rules so a secret inside a URL is gone either way.
// Lookbehinds use [A-Za-z0-9] (not \b) so `_` and `-` before a token do not hide it.
const NOT_ALNUM = "(?<![A-Za-z0-9])";

// The optional BLOCK covers PGP ("PRIVATE KEY BLOCK"); an unterminated block is cut to the end of text, the safe side.
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
const TOKENS: readonly RegExp[] = [
	new RegExp(`${NOT_ALNUM}sk-[A-Za-z0-9_-]{16,}`, "g"), // sk-, sk-ant-, sk-or-
	new RegExp(`${NOT_ALNUM}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, "g"),
	new RegExp(`${NOT_ALNUM}(?:AKIA|ASIA)[A-Z0-9]{16}`, "g"),
	new RegExp(`${NOT_ALNUM}xox[abprs]-[A-Za-z0-9-]{10,}`, "g"),
	// Minimum lengths sit above ordinary words: fc-barcelona and st.louis survive.
	new RegExp(`${NOT_ALNUM}(?:pplx-[A-Za-z0-9]{20,}|tvly-[A-Za-z0-9_-]{16,}|fc-[A-Za-z0-9]{24,}|xai-[A-Za-z0-9]{20,})`, "g"),
	new RegExp(`${NOT_ALNUM}(?:gsk_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|phx_[A-Za-z0-9]{20,})`, "g"),
	new RegExp(`${NOT_ALNUM}(?:(?:pk|sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|pk_[A-Za-z0-9]{24,}|AIza[A-Za-z0-9_-]{30,}|st\\.[A-Za-z0-9_-]{32,}|xapp-[A-Za-z0-9-]{10,})`, "g"),
];
// JWT: "eyJ" (base64 of '{"') and 4+ more in one segment, 4+ in the next, then a dot and the rest of the segment after it. Each
// dotted run that holds "eyJ" is taken once and searched in jwtsIn: a regex starting at every "eyJ" rescanned a base64 blob of JSON
// from each (quadratic, lh-09r), and a run-start lookbehind missed a JWT glued after "_" or "-".
const JWT_RUN = /(?<![A-Za-z0-9_.-])(?=[A-Za-z0-9_.-]*eyJ)[A-Za-z0-9_.-]+/g;
// Header names that carry credentials; the value runs to the end of the line or the closing quote.
const HEADER =
	/(?<![A-Za-z0-9-])((?:X-[A-Za-z0-9-]*(?:Token|Key|Secret|Auth|Password)|Proxy-Authorization|Authorization|Set-Cookie|Cookie)["']?[ \t]*:[ \t]*)(?:"[^"\n]*"|'[^'\n]*'|[^\n"']*)/gi;
// The scheme starts its run, so a long run is scanned once rather than from every letter (lh-09r); the host can start anywhere.
const PATH_SECRET_URL =
	/(?:(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/)?(?:hooks\.slack\.com\/services\/|discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/|api\.telegram\.org\/(?:file\/)?bot)[^\s"'<>]+/gi;
const INLINE_ENV = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]+[ \t]*=(?![=>])[ \t]*)(?!\[redacted:)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g;
// CLI credential flags: KEY_VALUE only sees "=", and a flag also takes its value after whitespace. The name's last segment is a
// credential word, or it ends in api/access/secret/private key: `--token-count 5`, `--sort-key x` and `--passes 3` stay.
const FLAG =
	/(?<![A-Za-z0-9-])(--(?:[A-Za-z0-9]+[-_])*(?:password|passwd|passphrase|pass|token|secret|apikey|(?:api|access|secret|private)[-_]?key)(?:=|[ \t]+))(?!\[redacted:)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi;
// Short flags that carry a password under one command only (elsewhere `-p` is a port, `-u` a user). mysql takes it attached; a bare `-p` prompts and stays.
// The scan for the flag stops at the command's next occurrence, which takes it from there: scanning from each to the end of the
// line was quadratic (lh-09r).
const commandFlag = (command: string, flag: string) => `${command}\\b(?:(?!\\b${command}\\b)[^\\n;&|])*?[ \\t]${flag}`;
const COMMAND_FLAG = new RegExp(
	`(\\b(?:${[
		commandFlag("curl", "(?:-u[ \\t]*|--user(?:=|[ \\t]+))"),
		commandFlag("sshpass", "-p[ \\t]*"),
		commandFlag("docker[ \\t]+login", "-p[ \\t]*"),
		commandFlag("redis-cli", "-a[ \\t]*"),
		commandFlag("mysql", "-p"),
	].join("|")}))(?!\\[redacted:)(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s"']+)`,
	"g",
);
// A comma ends the value only before whitespace or the end: `password=abc,def` goes whole, `a=1, b=2` stays two. The key starts
// its run (the lookbehind takes _ . - too), so a long run is scanned once rather than from every _ . - (lh-09r).
const KEY_VALUE =
	/(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]*(?:pass(?:words?|wd|phrase)|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|credentials?)["']?[ \t]*[:=][ \t]*)(?!\[redacted:)(?:"[^"\n]*"|'[^'\n]*'|(?:[^\s"',;&)}\]]|,(?![\s"']|$))+)/gi;
// Alnum-only runs: hex digests and similar; the digit+letter test keeps long identifiers out.
const OPAQUE_RUN = /(?<![A-Za-z0-9])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ENV_LINE = /^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]+)=[^\n]*/gm;
// URL and email match what `\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+` and `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` match, but
// try each scheme or local-part run once rather than from every letter in it (quadratic on a long run, lh-09r). redactUrls finds
// where in the run `\b[a-z]` would start.
const SCHEME_RUN = /(?<![a-z0-9+.-])[a-z0-9+.-]+(?=:\/\/[^\s"'<>])/gi;
const URL_END = /[\s"'<>]|$/g;
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// The unanchored rule tries again where its last match ended, which can be inside a run: "a@b.com.x@y.com" is two matches.
const EMAIL_AT = new RegExp(EMAIL.source.replace(/^\(\?<!\[[^\]]*\]\)/, ""), "y");
const SPLIT_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
// Measured: slugs and hyphenated English sit below this, random base64url above it.
const MIN_ENTROPY = 4.4;

function entropy(run: string): number {
	const counts = new Map<string, number>();
	for (const c of run) counts.set(c, (counts.get(c) ?? 0) + 1);
	let h = 0;
	for (const n of counts.values()) h -= (n / run.length) * Math.log2(n / run.length);
	return h;
}

/** Tokens split by "-" or "_" escape the alnum rule; entropy tells them from slugs and compounds. A UUID (17 symbols, at most 4.09) never passes. */
function redactSplitRun(run: string): string {
	return /\d/.test(run) && entropy(run) >= MIN_ENTROPY ? "[redacted:secret]" : run;
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

type Span = readonly [start: number, end: number];

// The named rules again, anchored at a fragment start: in a joined view a token that starts a line follows the last run of the line
// before, which defeats the rule's lookbehind. Every TOKENS rule starts with a lookbehind; this drops it.
const TOKENS_AT = TOKENS.map((re) => new RegExp(re.source.replace(/^\(\?<!\[[^\]]*\]\)/, ""), "y"));

/** Where the JWTs in one dotted run are, leftmost first, as the regex `eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*` would find them. */
function jwtsIn(run: string): Span[] {
	const spans: Span[] = [];
	const segs = run.split(".");
	for (let i = 0, at = 0; i + 2 < segs.length; ) {
		const [a, b, c] = [segs[i]!, segs[i + 1]!, segs[i + 2]!];
		const head = a.indexOf("eyJ");
		if (head >= 0 && a.length - head >= 7 && b.length >= 4) {
			spans.push([at + head, at + a.length + b.length + c.length + 2]);
			at += a.length + b.length + c.length + 3;
			i += 3;
		} else {
			at += a.length + 1;
			i++;
		}
	}
	return spans;
}

function redactJwts(run: string): string {
	let out = "";
	let from = 0;
	for (const [start, end] of jwtsIn(run)) {
		out += `${run.slice(from, start)}[redacted:secret]`;
		from = end;
	}
	return out + run.slice(from);
}

/** Where the named rules would redact `s`, also starting at each of `starts`. */
function namedSpans(s: string, starts: readonly number[]): Span[] {
	const spans: Span[] = [];
	for (const m of s.matchAll(JWT_RUN)) for (const [start, end] of jwtsIn(m[0])) spans.push([m.index + start, m.index + end]);
	for (const re of TOKENS) for (const m of s.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
	for (const re of TOKENS_AT) {
		// starts come in order; one inside the last span is not tried, since each match from there ran to the end of the joined run
		// (quadratic, lh-09r). shortcut: a second token glued to the first and starting a line inside its span is not matched from
		// that line start here, only by redactGroup's scan of that line alone; try such starts against the span end if that shows up.
		let end = 0;
		for (const at of starts) {
			if (at < end) continue;
			re.lastIndex = at;
			const m = re.exec(s);
			if (m) spans.push([at, (end = at + m[0].length)]);
		}
	}
	return spans;
}

/** Where the run-level rules would redact `s`, measured on `s` itself rather than after earlier replacements. */
function runSpans(s: string, starts: readonly number[] = []): Span[] {
	const spans = namedSpans(s, starts);
	for (const m of s.matchAll(OPAQUE_RUN)) spans.push([m.index, m.index + m[0].length]);
	for (const m of s.matchAll(SPLIT_RUN)) if (redactSplitRun(m[0]) !== m[0]) spans.push([m.index, m.index + m[0].length]);
	return spans;
}

/** Where each fragment after the first starts in the joined view. */
function cutsOf(frags: readonly string[]): number[] {
	const cuts: number[] = [];
	for (let k = 0, at = 0; k < frags.length - 1; k++) cuts.push((at += frags[k]!.length));
	return cuts;
}

/** For each cut, whether a span runs across it. A difference array keeps it linear, not cuts × spans. */
function crossed(spans: readonly Span[], cuts: readonly number[], length: number): boolean[] {
	const inside = new Int32Array(length + 1);
	for (const [start, end] of spans) {
		inside[start + 1]!++;
		inside[end]!--;
	}
	for (let i = 1; i <= length; i++) inside[i]! += inside[i - 1]!;
	return cuts.map((cut) => inside[cut]! > 0);
}

/** `named`: a named rule runs across this break, measured on the whole chain. */
function joinable(left: string, right: string, named: boolean): boolean {
	if (named) return true;
	// one cwd slug per line is a list, not a wrapped token
	if (left.startsWith("-") && right.startsWith("-")) return false;
	// next to a plain word, only a named token rule running across the break joins
	return !PLAIN_WORD.test(left) && !PLAIN_WORD.test(right);
}

/** `group` alternates fragment, separator, fragment. Redacts the joined view only when a rule runs across a break. */
function redactGroup(group: readonly string[]): string {
	if (group.length === 1) return group[0]!;
	const frags = group.filter((_, i) => i % 2 === 0);
	const joined = frags.join("");
	const cuts = cutsOf(frags);
	const spans = runSpans(joined, cuts);
	if (!crossed(spans, cuts, joined.length).includes(true)) return group.join("");
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
	const frags = parts.filter((_, i) => i % 2 === 0);
	const cuts = cutsOf(frags);
	// The named rules see the whole chain, both sides of each break: a plain-looking fragment inside a token wrapped many times at a
	// narrow column still joins, and so does one that comes before the fragment that completes a fixed-length token.
	const joined = frags.join("");
	const named = crossed(namedSpans(joined, cuts), cuts, joined.length);
	let out = "";
	let group = [frags[0]!];
	for (let k = 1; k < frags.length; k++) {
		const sep = parts[2 * k - 1]!;
		if (joinable(frags[k - 1]!, frags[k]!, named[k - 1]!)) group.push(sep, frags[k]!);
		else {
			out += redactGroup(group) + sep;
			group = [frags[k]!];
		}
	}
	return out + redactGroup(group);
}

/** URLs that carry credentials, starting where `\b[a-z]` would in each scheme run. */
function redactUrls(s: string): string {
	let out = "";
	let from = 0;
	SCHEME_RUN.lastIndex = 0;
	for (let m; (m = SCHEME_RUN.exec(s)); ) {
		const runEnd = SCHEME_RUN.lastIndex;
		// the leftmost letter at a word boundary: the run start, or a letter after + . or -
		let p = m.index;
		while (p < runEnd && !(/[a-z]/i.test(s[p]!) && !/\w/.test(s[p - 1] ?? ""))) p++;
		// none: the unanchored rule matches nothing in this run and scans on into the URL after it
		if (p === runEnd) continue;
		URL_END.lastIndex = runEnd + 3;
		const end = URL_END.exec(s)!.index;
		SCHEME_RUN.lastIndex = end;
		// A "#" fragment holding key=value is an OAuth-style token carrier; bare anchors like #L10 stay.
		if (/[?]|#[^#\s]*=|\/\/[^/]*@/.test(s.slice(p, end))) {
			out += `${s.slice(from, p)}[redacted:url]`;
			from = end;
		}
	}
	return out + s.slice(from);
}

function redactEmails(s: string): string {
	let out = "";
	let from = 0;
	EMAIL.lastIndex = 0;
	for (let m = EMAIL.exec(s); m; ) {
		out += `${s.slice(from, m.index)}[redacted:email]`;
		from = EMAIL.lastIndex = EMAIL_AT.lastIndex = m.index + m[0].length;
		m = EMAIL_AT.exec(s) ?? EMAIL.exec(s);
	}
	return out + s.slice(from);
}

/** Pure and idempotent: placeholders never match any rule. Always on; there is no switch. */
export function redact(text: string): string {
	let out = text.replace(PEM, "[redacted:key]");
	out = out.replace(WRAP_CHAIN, redactWrapped);
	out = out.replace(JWT_RUN, redactJwts);
	for (const re of TOKENS) out = out.replace(re, "[redacted:secret]");
	out = out.replace(BEARER, "Bearer [redacted:token]");
	out = out.replace(HEADER, "$1[redacted:header]");
	out = out.replace(PATH_SECRET_URL, "[redacted:url]");
	out = redactUrls(out);
	out = out.replace(ENV_LINE, "$1=[redacted:env]");
	out = out.replace(INLINE_ENV, "$1[redacted:env]");
	out = out.replace(FLAG, "$1[redacted:secret]");
	out = out.replace(COMMAND_FLAG, "$1[redacted:secret]");
	out = out.replace(KEY_VALUE, "$1[redacted:secret]");
	// SPLIT_RUN first: OPAQUE_RUN would replace an alnum stretch inside a dashed token and leave pieces too short for SPLIT_RUN.
	out = out.replace(SPLIT_RUN, redactSplitRun);
	out = out.replace(OPAQUE_RUN, "[redacted:secret]");
	// Again: cutting an alnum stretch out of a low-entropy run can leave a random piece that is a run of its own (idempotence).
	out = out.replace(SPLIT_RUN, redactSplitRun);
	out = redactEmails(out);
	for (const re of HOME_PATHS) out = out.replace(re, "~");
	return out;
}
