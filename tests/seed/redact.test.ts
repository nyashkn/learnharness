import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { redact } from "../../src/seed/redact";

// Token-shaped inputs are joined at runtime so no literal here matches a real token format (secret scanners); the joined value keeps the real shape.
const t = (...parts: string[]) => parts.join("");
const A62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// deterministic mixed letters and digits; 7 is coprime to 62, so no character repeats within 62
const fake = (n: number) => Array.from({ length: n }, (_, i) => A62[(i * 7 + 3) % 62]).join("");

// Credential flags, with "=" and with whitespace before the value.
const FLAGS = ["--password", "--passwd", "--token", "--api-key", "--apikey", "--secret", "--auth-token", "--access-token"];
const FLAG_ROWS = FLAGS.flatMap((f) =>
	(["=", " "] as const).map((sep) => [`flag ${f} ${sep === "=" ? "equals" : "space"}`, t("run ", f, sep, fake(12), " now"), `run ${f}${sep}[redacted:secret] now`] as const),
);

// Every expected value is a literal written by hand; none is computed by redact.
const SHAPES: ReadonlyArray<readonly [name: string, input: string, expected: string]> = [
	...FLAG_ROWS,
	["flag-like option survives", "run --token-count 5 now", "run --token-count 5 now"],
	// inline and spaced env
	["env after &&", "cd app && API_KEY=abc123xyz run", "cd app && API_KEY=[redacted:env] run"],
	["env with spaces", "API_KEY = abc123xyz", "API_KEY = [redacted:env]"],
	["env in docker -e", "docker run -e FOO_BAR=hunter22 img", "docker run -e FOO_BAR=[redacted:env] img"],
	["env prefix before a command", "FOO=abc123 node app.js", "FOO=[redacted:env]"],
	["env quoted with spaces", "run MY_VAR=\"two words\" now", "run MY_VAR=[redacted:env] now"],
	// key-name rule
	["api_key lowercase", "api_key=abc123xyz", "api_key=[redacted:secret]"],
	["password yaml", "password: hunter2", "password: [redacted:secret]"],
	["json apiKey", '{"apiKey": "abc123xyz"}', "{\"apiKey\": [redacted:secret]}"],
	["json password no space", '{"password":"hunter2","user":"bob"}', '{"password":[redacted:secret],"user":"bob"}'],
	["passwd", "passwd=s3cr3t", "passwd=[redacted:secret]"],
	["pwd", "pwd: s3cr3t", "pwd: [redacted:secret]"],
	["secret", "secret = s3cr3t", "secret = [redacted:secret]"],
	["client_secret", "client_secret: s3cr3t", "client_secret: [redacted:secret]"],
	["apikey", "apikey=abc123", "apikey=[redacted:secret]"],
	["api-key", "api-key: abc123", "api-key: [redacted:secret]"],
	["access_key", "access_key=abc123", "access_key=[redacted:secret]"],
	["private_key", "private_key: abc123", "private_key: [redacted:secret]"],
	["auth_token", "auth_token=abc123", "auth_token=[redacted:secret]"],
	["access_token", "access_token: abc123", "access_token: [redacted:secret]"],
	["refresh_token", "refresh_token=abc123", "refresh_token=[redacted:secret]"],
	["token", "token=abc123", "token=[redacted:secret]"],
	["credentials", "credentials: abc123", "credentials: [redacted:secret]"],
	["uppercase key", "Password: Hunter2", "Password: [redacted:secret]"],
	["uuid under a key", "api_key=3f2b8c1e-9a4d-4e7b-8c5f-1a2b3c4d5e6f", "api_key=[redacted:secret]"],
	// headers
	["X-Api-Key", "X-Api-Key: abc123xyz", "X-Api-Key: [redacted:header]"],
	["X-Auth-Token", "X-Auth-Token: abc123xyz", "X-Auth-Token: [redacted:header]"],
	["X-*-Key", "x-custom-key: abc123xyz", "x-custom-key: [redacted:header]"],
	["Basic", "Authorization: Basic dXNlcjpwYXNz", "Authorization: [redacted:header]"],
	["Token", "Authorization: Token abc123xyz", "Authorization: [redacted:header]"],
	["Bearer header", "Authorization: Bearer abc12345678", "Authorization: [redacted:header]"],
	["Cookie", "Cookie: session=abc123; theme=dark", "Cookie: [redacted:header]"],
	["Set-Cookie", "Set-Cookie: sid=abc123; HttpOnly", "Set-Cookie: [redacted:header]"],
	["curl -H quoted", 'curl -H "X-Api-Key: abc123xyz" https://example.com/v1', 'curl -H "X-Api-Key: [redacted:header]" https://example.com/v1'],
	// provider prefixes
	["pplx", t("use pplx-", fake(32), " now"), "use [redacted:secret] now"],
	["tvly", t("use tvly-dev-", fake(18), " now"), "use [redacted:secret] now"],
	["fc", t("use fc-", "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d now"), "use [redacted:secret] now"],
	["xai", t("use xai-", fake(32), " now"), "use [redacted:secret] now"],
	["gsk", t("use gsk_", fake(27), " now"), "use [redacted:secret] now"],
	["hf", t("use hf_", "ZkQmWxLpVbNcTdHyRgJfUaBeCoDiEg now"), "use [redacted:secret] now"],
	["npm", t("use npm_", "ZkQmWxLpVbNcTdHyRgJfUaBeCoDiEgFhIj now"), "use [redacted:secret] now"],
	["glpat", t("use glpat-", fake(20), " now"), "use [redacted:secret] now"],
	["phx", t("use phx_", "ZkQmWxLpVbNcTdHyRgJfUaBeCoDiEg now"), "use [redacted:secret] now"],
	["pk_live", t("use pk_live_", fake(20), " now"), "use [redacted:secret] now"],
	["pk plain", t("use pk_", "ZkQmWxLpVbNcTdHyRgJfUaBeCoDiEg now"), "use [redacted:secret] now"],
	["sk_live", t("use sk_live_", fake(20), " now"), "use [redacted:secret] now"],
	["sk_test", t("use sk_test_", fake(20), " now"), "use [redacted:secret] now"],
	["rk_live", t("use rk_live_", fake(20), " now"), "use [redacted:secret] now"],
	// dashes and underscores split the run, so only the AIza rule can catch it
	["AIza", t("use AIza", "SyDk3Qm9Wx7-Lp2Vb8Nc4Td6_Hy1Rg5Jf0Ua now"), "use [redacted:secret] now"],
	["st.", t("use st.", fake(36), " now"), "use [redacted:secret] now"],
	["xapp", t("use xapp-", "1-A0123BCDE-123456789-abcdef now"), "use [redacted:secret] now"],
	// key blocks
	["PEM", t("-----BEGIN RSA PRIVATE KEY-----\n", "MIIabc\n-----END RSA PRIVATE KEY-----"), "[redacted:key]"],
	["PGP block", t("-----BEGIN PGP PRIVATE KEY BLOCK-----\n", "lQOYBFabc\n=ab12\n-----END PGP PRIVATE KEY BLOCK-----"), "[redacted:key]"],
	// URLs
	["fragment token", t("https://app.example.com/cb#access_token=", "abc123&type=bearer"), "[redacted:url]"],
	["slack webhook", t("curl -X POST https://hooks.slack.com/services/", "T0AAAA0AA/B0BBBB0BB/xYz123AbC456dEf789gHi012"), "curl -X POST [redacted:url]"],
	["discord webhook", t("https://discord.com/api/webhooks/", "123456789012345678/AbCdEf-gHiJkL_mNoPq"), "[redacted:url]"],
	["telegram bot", t("https://api.telegram.org/bot123456789:", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe"), "[redacted:url]"],
	["telegram without scheme", t("GET api.telegram.org/bot123456789:", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe"), "GET [redacted:url]"],
	// opaque catch-all
	["opaque run", "blob 9fA3kLq0ZxV7bN2mC5dR8sT1yW4uE6iO end", "blob [redacted:secret] end"],
	["opaque hex digest", "sha 0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091 end", "sha [redacted:secret] end"],
	["split token", "tok aB3-dE9_fG2-hJ7_kL4-mN8_pQ1-rS5_tU6-vW0 end", "tok [redacted:secret] end"],
	// must survive
	["slug with a digit", "cwd -Users-someone-Documents-dev_work-client-x2 ok", "cwd ~-Documents-dev_work-client-x2 ok"],
	["long slug with digits", "-opt-work-client-x2-learn-harness-fork-feature-lh-epic-2026", "-opt-work-client-x2-learn-harness-fork-feature-lh-epic-2026"],
	["maths", "x = n^2", "x = n^2"],
	["short upper assignment", "N=5", "N=5"],
	["big-O", "O(n log n)", "O(n log n)"],
	["plain url", "see https://en.wikipedia.org/wiki/Monad_(functional_programming) for details", "see https://en.wikipedia.org/wiki/Monad_(functional_programming) for details"],
	["anchor url", "https://example.com/docs/api#L10", "https://example.com/docs/api#L10"],
	["question quicksort", "why does quicksort degrade", "why does quicksort degrade"],
	["question monad", "what is a monad", "what is a monad"],
	["fc-barcelona", "fc-barcelona won", "fc-barcelona won"],
	["st. short", "st.louis is nice", "st.louis is nice"],
	["token prose", "the token budget is small", "the token budget is small"],
	["max_tokens", "max_tokens: 4096", "max_tokens: 4096"],
	["uuid", "session 3f2b8c1e-9a4d-4e7b-8c5f-1a2b3c4d5e6f", "session 3f2b8c1e-9a4d-4e7b-8c5f-1a2b3c4d5e6f"],
	["long identifier", "useSomethingVeryLongIdentifierNameForTheThing", "useSomethingVeryLongIdentifierNameForTheThing"],
	["cwd slug", "-Users-someone-work-client-x", "~-work-client-x"],
	["hyphenated compound", "well-known-high-quality-open-source-library-name-here", "well-known-high-quality-open-source-library-name-here"],
	["placeholders", "[redacted:secret] [redacted:env] [redacted:header] [redacted:url] [redacted:key]", "[redacted:secret] [redacted:env] [redacted:header] [redacted:url] [redacted:key]"],
	["key over placeholder", "password: [redacted:secret]", "password: [redacted:secret]"],
];

const PLACEHOLDERS = ["[redacted:secret]", "[redacted:key]", "[redacted:env]", "[redacted:token]", "[redacted:url]", "[redacted:email]", "[redacted:header]", "~"];

// ---- generators built from documented token formats, not from the redactor ----
const ALNUM = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
const chars = (set: string[], min: number, max = min) => fc.array(fc.constantFrom(...set), { minLength: min, maxLength: max }).map((a) => a.join(""));
// "Z9" prefix keeps a planted value from colliding with surrounding words
const value = chars(ALNUM, 8, 24).map((v) => `Z9${v}`);

interface Plant {
	text: string;
	secret: string;
	ownLine?: boolean;
}

const KEYS = ["password", "passwd", "pwd", "secret", "client_secret", "api_key", "apikey", "api-key", "access_key", "private_key", "auth_token", "access_token", "refresh_token", "token", "credentials", "DB_PASSWORD", "apiKey", "Token"];
const ENVS = ["API_KEY", "FOO_BAR", "XY", "MY_SECRET", "DB_URL"];
const HEADERS = ["X-Api-Key", "X-Auth-Token", "X-Custom-Key", "Authorization: Basic", "Authorization: Token", "Cookie", "Set-Cookie"];
const PREFIXES: ReadonlyArray<readonly [string, number]> = [
	["pplx-", 20], ["tvly-", 16], ["fc-", 24], ["xai-", 20], ["gsk_", 20], ["hf_", 20], ["npm_", 20], ["glpat-", 16], ["phx_", 20],
	["pk_live_", 16], ["pk_test_", 16], ["sk_live_", 16], ["sk_test_", 16], ["rk_live_", 16], ["xapp-", 10],
];

const plant: fc.Arbitrary<Plant> = fc.oneof(
	fc.tuple(fc.constantFrom(...KEYS), fc.constantFrom("=", ": ", " = ", ":"), value).map(([k, sep, v]) => ({ text: `${k}${sep}${v}`, secret: v })),
	fc.tuple(fc.constantFrom(...KEYS), value).map(([k, v]) => ({ text: `{"${k}": "${v}"}`, secret: v })),
	fc.tuple(fc.constantFrom(...ENVS), fc.constantFrom("=", " = "), value).map(([n, sep, v]) => ({ text: `cd x && ${n}${sep}${v} run`, secret: v })),
	fc.tuple(fc.constantFrom(...HEADERS), value).map(([h, v]) => ({ text: `${h.includes(":") ? h : `${h}:`} ${v}`, secret: v, ownLine: true })),
	fc.tuple(fc.constantFrom(...PREFIXES), fc.nat(10)).chain(([[p, min], extra]) => chars(ALNUM, min + extra).map((b) => ({ text: `${p}${b}`, secret: b }))),
	chars([...ALNUM, "-", "_"], 30, 40).map((b) => ({ text: `AIza${b}`, secret: b.slice(4, 24) })),
	fc.tuple(chars(ALNUM, 9), chars(ALNUM, 9), chars(ALNUM, 24)).map(([a, b, c]) => ({ text: `https://hooks.slack.com/services/T${a}/B${b}/${c}`, secret: c })),
	fc.tuple(chars(["0", "1", "2", "3"], 9), chars(ALNUM, 35)).map(([id, t]) => ({ text: `https://api.telegram.org/bot${id}:${t}/getMe`, secret: t })),
	chars(ALNUM, 12, 24).map((t) => ({ text: `https://app.example.com/cb#access_token=Z9${t}&x=1`, secret: `Z9${t}` })),
	chars([...ALNUM, "+", "/"], 40, 60).map((b) => ({ text: `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${b}\n-----END PGP PRIVATE KEY BLOCK-----`, secret: b })),
	// letters+digits only, 32..64 long, with a guaranteed digit and letter
	chars(ALNUM, 31, 63).map((b) => ({ text: `A1${b}`, secret: b })),
);

const noise = fc.constantFrom("please look at this", "here is the log", "I tried it and", "");
const embedded = fc.tuple(noise, fc.constantFrom(" ", "\n", "(", ": "), plant, fc.constantFrom(" ", "\n", ". ", ""), noise).map(([a, sep, p, end, b]) => ({
	p,
	text: `${a}${p.ownLine ? "\n" : sep}${p.text}${end}${b}`,
}));

const word = fc.stringMatching(/^[a-z]{3,12}$/).filter((w) => !["glpat", "pplx", "tvly", "xapp"].includes(w));

describe("redact shapes", () => {
	for (const [name, input, expected] of SHAPES) {
		it(name, () => assert.equal(redact(input), expected));
	}
});

describe("redact properties", () => {
	it("a planted value never survives", () => {
		fc.assert(
			fc.property(embedded, ({ p, text }) => {
				assert.ok(!redact(text).includes(p.secret), `survived: ${p.secret}`);
			}),
			{ numRuns: 500 },
		);
	});

	it("is idempotent over mixed text with every placeholder", () => {
		const piece = fc.oneof(fc.constantFrom(...PLACEHOLDERS), plant.map((p) => p.text), noise, fc.constantFrom("password: ", "API_KEY=", "Cookie: ", "token="));
		fc.assert(
			fc.property(fc.array(piece, { maxLength: 8 }), fc.constantFrom(" ", "\n"), (parts, sep) => {
				const once = redact(parts.join(sep));
				assert.equal(redact(once), once);
			}),
			{ numRuns: 500 },
		);
	});

	it("placeholders alone and after a key survive", () => {
		for (const ph of PLACEHOLDERS) assert.equal(redact(ph), ph);
		for (const k of KEYS) assert.equal(redact(`${k}: [redacted:secret]`), `${k}: [redacted:secret]`);
	});

	it("uuids survive", () => {
		fc.assert(fc.property(fc.uuid(), (u) => redact(u) === u && redact(`session ${u} ok`) === `session ${u} ok`));
	});

	it("hyphenated slugs and compounds survive", () => {
		fc.assert(
			fc.property(fc.array(word, { minLength: 2, maxLength: 14 }), (words) => {
				const slug = `-srv-${words.join("-")}`;
				assert.equal(redact(slug), slug);
				assert.equal(redact(words.join("-")), words.join("-"));
			}),
			{ numRuns: 300 },
		);
	});
});

// ---- tokens wrapped across a line (lh-tw1.1, lh-lmc) and unbroken dashed tokens (lh-th2) ----
// Seeded measurement, 20,000 per row. Rates go out as test diagnostics; the bars are the beads' fixed numbers.

/** mulberry32: a fixed seed gives the same samples on every run. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let x = a;
		x = Math.imul(x ^ (x >>> 15), x | 1);
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}
const N = 20_000;
const B64URL = `${A62}-_`;
const UPPER36 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const DIGIT10 = "0123456789";
const HEX16 = "0123456789abcdef";
// lh-tw1.1 forms: LF, CRLF, then indentation, a quote prefix or a box prefix
const WRAPS = ["\n", "\r\n", "\n  ", "\r\n\t", "\n> ", "\r\n> ", "\n│ ", "\n    │ "];
// lh-lmc forms: trailing blanks, a right border, more prefixes, CR alone, NBSP indent
const MORE_WRAPS: ReadonlyArray<readonly [name: string, sep: string]> = [
	["two trailing spaces then LF", "  \n"],
	["trailing space then CRLF", " \r\n"],
	["right box border", " │\n│ "],
	['"| "', "\n| "],
	['"┃ "', "\n┃ "],
	['"║ "', "\n║ "],
	['"# "', "\n# "],
	['"// "', "\n// "],
	['" * "', "\n * "],
	['"+"', "\n+"],
	["CR alone", "\r"],
	["NBSP indent", "\n\u00a0\u00a0"],
];
const pick = (r: () => number, set: string, n: number) => Array.from({ length: n }, () => set[Math.floor(r() * set.length)]).join("");
const wrapAt = (r: () => number, token: string, sep: string) => {
	const at = 1 + Math.floor(r() * (token.length - 1));
	return t(token.slice(0, at), sep, token.slice(at));
};
const wrapOnce = (r: () => number, token: string) => wrapAt(r, token, WRAPS[Math.floor(r() * WRAPS.length)]!);
/** A body fragment leaks when `min` consecutive body characters survive outside a placeholder. */
function leaks(text: string, body: string, min = 4): boolean {
	const out = redact(text).replace(/\[redacted:[a-z]+\]/g, " ");
	for (let i = 0; i + min <= body.length; i++) if (out.includes(body.slice(i, i + min))) return true;
	return false;
}
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

describe("unbroken dashed tokens (lh-th2)", () => {
	// 8+ char fragments; the bead's bar per length
	for (const [len, seed, bar] of [[40, 4001, 0.005], [48, 4801, 0.001], [64, 6401, 0.001]] as const) {
		it(`random base64url ${len}-char tokens leak an 8+ char fragment at most ${pct(bar)}`, (ctx) => {
			const r = prng(seed);
			let leak8 = 0;
			let leak4 = 0;
			for (let i = 0; i < N; i++) {
				const token = pick(r, B64URL, len);
				const text = t("see ", token, " done");
				if (leaks(text, token, 8)) leak8++;
				if (leaks(text, token, 4)) leak4++;
			}
			ctx.diagnostic(`unbroken ${len}: 8+ leak ${pct(leak8 / N)}, 4+ leak ${pct(leak4 / N)}`);
			assert.ok(leak8 / N <= bar);
		});
	}
});

describe("wrapped tokens (lh-tw1.1)", () => {
	// absolute bar: the unbroken 4+ rate measured after lh-th2 is under 1% at every length, so wrapped must be under 2%
	for (const [len, seed] of [[40, 4001], [48, 4801], [64, 6401]] as const) {
		it(`random ${len}-char tokens: wrapped leak within 1 point of unbroken and under 2%`, (ctx) => {
			const r = prng(seed);
			let unbroken = 0;
			let wrapped = 0;
			for (let i = 0; i < N; i++) {
				const token = pick(r, B64URL, len);
				if (leaks(t("see ", token, " done"), token)) unbroken++;
				if (leaks(t("see ", wrapOnce(r, token), " done"), token)) wrapped++;
			}
			ctx.diagnostic(`len ${len}: unbroken leak ${pct(unbroken / N)}, wrapped leak ${pct(wrapped / N)}`);
			assert.ok((wrapped - unbroken) / N <= 0.01, `wrapped ${pct(wrapped / N)} vs unbroken ${pct(unbroken / N)}`);
			assert.ok(wrapped / N < 0.02);
		});
	}

	// only OPAQUE_RUN catches hex (its entropy is under MIN_ENTROPY), so this row fails if the join stops scanning with it
	it("wrapped 40-char hex digests: within 1 point of unbroken and under 1%", (ctx) => {
		const r = prng(4040);
		let unbroken = 0;
		let wrapped = 0;
		for (let i = 0; i < N; i++) {
			const hex = t(pick(r, HEX16, 39), pick(r, "abcdef", 1));
			if (leaks(t("sha ", hex, " ok"), hex)) unbroken++;
			if (leaks(t("sha ", wrapOnce(r, hex), " ok"), hex)) wrapped++;
		}
		ctx.diagnostic(`hex 40: unbroken leak ${pct(unbroken / N)}, wrapped leak ${pct(wrapped / N)}`);
		assert.ok((wrapped - unbroken) / N <= 0.01);
		assert.ok(wrapped / N < 0.01);
	});

	const PREFIXED: ReadonlyArray<readonly [string, number, (r: () => number) => [prefix: string, body: string]]> = [
		["sk-", 501, (r) => ["sk-", pick(r, A62, 48)]],
		["ghp_", 502, (r) => ["ghp_", pick(r, A62, 36)]],
		["pplx-", 503, (r) => ["pplx-", pick(r, A62, 48)]],
		["xoxb-", 504, (r) => ["xoxb-", t(pick(r, DIGIT10, 12), "-", pick(r, DIGIT10, 12), "-", pick(r, A62, 24))]],
		["AKIA", 505, (r) => ["AKIA", pick(r, UPPER36, 16)]],
	];
	for (const [name, seed, make] of PREFIXED) {
		it(`wrapped ${name} tokens never leak a body fragment`, (ctx) => {
			const r = prng(seed);
			let wrapped = 0;
			for (let i = 0; i < N; i++) {
				const [prefix, body] = make(r);
				if (leaks(t("see ", wrapOnce(r, t(prefix, body)), " done"), body)) wrapped++;
			}
			ctx.diagnostic(`${name}: wrapped leak ${pct(wrapped / N)}`);
			assert.equal(wrapped, 0);
		});
	}
});

describe("more wrap forms (lh-lmc)", () => {
	MORE_WRAPS.forEach(([name, sep], i) => {
		it(`${name}: base64url 48 and sk- 48 leak an 8+ char fragment at most 1%`, (ctx) => {
			const r = prng(9000 + i);
			let generic = 0;
			let sk = 0;
			for (let k = 0; k < N; k++) {
				const token = pick(r, B64URL, 48);
				if (leaks(t("see ", wrapAt(r, token, sep), " done"), token, 8)) generic++;
				const body = pick(r, A62, 48);
				if (leaks(t("see ", wrapAt(r, t("sk-", body), sep), " done"), body, 8)) sk++;
			}
			ctx.diagnostic(`${name}: base64url 48 ${pct(generic / N)}, sk- ${pct(sk / N)}`);
			assert.ok(generic / N <= 0.01);
			assert.ok(sk / N <= 0.01);
		});
	});
});

describe("wrapped redaction, exact output", () => {
	const B = fake(60); // letters and digits, deterministic
	const H = Array.from({ length: 40 }, (_, i) => HEX16[(i * 7 + 3) % 16]).join(""); // hex with letters and digits
	const ROWS: ReadonlyArray<readonly [name: string, input: string, expected: string]> = [
		["sk- after a quote prefix", t("use sk-", B.slice(0, 10), "\n> ", B.slice(10, 40), " now"), "use [redacted:secret] now"],
		["generic run after trailing spaces", t("see ", B.slice(0, 20), "  \n", B.slice(20, 48), " done"), "see [redacted:secret] done"],
		["hex digest over CRLF", t("sha ", H.slice(0, 15), "\r\n", H.slice(15), " ok"), "sha [redacted:secret] ok"],
		["right box border", t("│ key ", B.slice(0, 20), " │\n│ ", B.slice(20, 48), " │"), "│ key [redacted:secret] │"],
		["wrapped twice with indentation", t("use sk-", B.slice(0, 12), "\n  ", B.slice(12, 30), "\n  ", B.slice(30, 60), " now"), "use [redacted:secret] now"],
		["a break outside the redaction stays", t("the end.\n", B.slice(0, 20), "\n", B.slice(20, 48), " ok"), "the end.\n[redacted:secret] ok"],
		["a blank line after the token stays", t("use sk-", B.slice(0, 12), "\n", B.slice(12, 30), "\n\nthen more"), "use [redacted:secret]\n\nthen more"],
	];
	for (const [name, input, expected] of ROWS) it(name, () => assert.equal(redact(input), expected));

	it("no join across a blank line, form feed, U+2028, U+2029 or NEL", () => {
		for (const sep of ["\n\n", "\f", "\u2028", "\u2029", "\u0085", "\n \n"]) {
			const input = t("see ", B.slice(0, 20), sep, B.slice(20, 40), " done");
			assert.equal(redact(input), input, JSON.stringify(sep));
		}
	});

	// x1.y2 lines join with each other but never form a match, so they only push the running length
	const filler = (n: number) => Array.from({ length: n }, () => "x1.y2\n").join("");
	it("a token wrapped 3,000 characters into a chain of joinable lines is still joined", () => {
		const body = B.slice(0, 40);
		const out = redact(t(filler(600), "use sk-", body.slice(0, 18), "\n", body.slice(18), " now"));
		assert.ok(out.endsWith("use [redacted:secret] now"));
	});
	it("MAX_JOIN is 4096: a break exactly at that length starts a new group (known limit, lh-09r)", () => {
		// 815 fillers of 5 chars = 4075, then "sk-" + 18 = 4096, so the second fragment is outside the group
		const body = B.slice(0, 40);
		const out = redact(t(filler(815), "sk-", body.slice(0, 18), "\n", body.slice(18), " now"));
		assert.ok(out.endsWith(t("[redacted:secret]\n", body.slice(18), " now")));
	});
});

describe("false positives (lh-tw1.1, lh-lmc)", () => {
	// directory names as they appear in cwd slugs; the mixed case comes from the names themselves
	const DIRS = ["Documents", "dev", "work", "personal", "productivity", "learn", "harness", "fork", "feature", "projects", "Mobile", "Data", "payments", "frontend", "infra", "Initech", "acme", "client", "api", "web", "app", "core", "Shared", "notes", "src", "code", "repos", "Desktop", "sandbox", "experiments", "2025", "v2", "EK", "RK"];
	const slug = (r: () => number) => `-Users-alice-${Array.from({ length: 3 + Math.floor(r() * 9) }, () => DIRS[Math.floor(r() * DIRS.length)]).join("-")}`;
	it("mixed-case slugs: at most 0.25% alone, and a one-per-line list redacts exactly as its lines do", (ctx) => {
		const r = prng(777);
		let single = 0;
		let listed = 0;
		for (let i = 0; i < N; i++) {
			const a = slug(r);
			const b = slug(r);
			if (redact(a).includes("[redacted:")) single++;
			const list = redact(t(a, "\n", b));
			if (list.includes("[redacted:")) listed++;
			assert.equal(list, t(redact(a), "\n", redact(b)));
		}
		ctx.diagnostic(`slugs: alone ${pct(single / N)}, in a two-line list ${pct(listed / N)}`);
		assert.ok(single / N <= 0.0025);
	});

	const WORDS = ["the", "quick", "parser", "returns", "a", "value", "when", "input", "is", "empty", "and", "then", "we", "retry", "with", "backoff", "because", "network", "errors", "happen", "often", "in", "practice", "eigenvalues", "matrix", "sorted", "pivot", "element", "quicksort", "degrades", "version", "release", "notes", "build", "test", "server", "client", "request", "response", "2025", "12", "v2", "O(n)", "x86_64", "README.md", "config.json"];
	const words = (r: () => number, n: number) => Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(" ");
	const breaks = ["\n", "\r\n", "  \n", "\n> ", "\n│ ", "\n| ", "\n# ", "\n// ", "\n * ", "\n+", "\r", " │\n│ "];
	const seg = (r: () => number) => pick(r, "abcdefghijklmnopqrstuvwxyz", 3 + Math.floor(r() * 8)) + (r() < 0.3 ? pick(r, DIGIT10, 1 + Math.floor(r() * 4)) : "");
	const uuid = (r: () => number) => [8, 4, 4, 4, 12].map((n) => pick(r, HEX16, n)).join("-");
	const GEN: ReadonlyArray<readonly [name: string, make: (r: () => number) => string]> = [
		["prose", (r) => Array.from({ length: 3 + Math.floor(r() * 5) }, () => words(r, 4 + Math.floor(r() * 9))).join(breaks[Math.floor(r() * breaks.length)]!)],
		["paths", (r) => Array.from({ length: 2 + Math.floor(r() * 6) }, () => {
			const parts = Array.from({ length: 2 + Math.floor(r() * 5) }, () => seg(r));
			const file = `${parts.join("/")}.${["ts", "md", "json", "py", "log"][Math.floor(r() * 5)]}`;
			return [`/opt/${file}`, `./${file}`, file, `C:\\${parts.join("\\")}`][Math.floor(r() * 4)];
		}).join(["\n", "\r\n", "\n  "][Math.floor(r() * 3)]!)],
		["JSON Lines", (r) => Array.from({ length: 2 + Math.floor(r() * 6) }, () => JSON.stringify({ id: Math.floor(r() * 1e6), name: seg(r), path: `${seg(r)}/${seg(r)}`, ok: r() < 0.5 })).join("\n")],
		["markdown tables", (r) => ["| name | count | path |", "|------|-------|------|", ...Array.from({ length: 2 + Math.floor(r() * 6) }, () => `| ${seg(r)} | ${Math.floor(r() * 1e4)} | ${seg(r)}/${seg(r)} |`)].join("\n")],
		["xxd dumps", (r) => Array.from({ length: 2 + Math.floor(r() * 6) }, (_, i) => {
			const bytes = Array.from({ length: 16 }, () => Math.floor(r() * 256));
			const hex = Array.from({ length: 8 }, (_, k) => bytes.slice(2 * k, 2 * k + 2).map((b) => b.toString(16).padStart(2, "0")).join("")).join(" ");
			const ascii = bytes.map((b) => (b >= 0x21 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
			return `${(i * 16).toString(16).padStart(8, "0")}: ${hex}  ${ascii}`;
		}).join("\n")],
		["UUID lists", (r) => Array.from({ length: 2 + Math.floor(r() * 8) }, () => uuid(r)).join(["\n", "\r\n", "\n  ", "\n- "][Math.floor(r() * 4)]!)],
	];
	GEN.forEach(([name, make], i) => {
		// the join and the rule order only ever write [redacted:secret]; other placeholders come from older rules and are reported
		it(`${name}: no [redacted:secret] in 2,000 seeded samples`, (ctx) => {
			const r = prng(12000 + i);
			let secret = 0;
			let any = 0;
			for (let k = 0; k < 2_000; k++) {
				const out = redact(make(r));
				if (out.includes("[redacted:secret]")) secret++;
				if (out.includes("[redacted:")) any++;
			}
			ctx.diagnostic(`${name}: [redacted:secret] ${pct(secret / 2_000)}, any placeholder ${pct(any / 2_000)}`);
			assert.equal(secret, 0);
		});
	});

	it("short SHA and camelCase lists: reported, not held to a bar (they already over-redact)", (ctx) => {
		const r = prng(13000);
		const camel = () => Array.from({ length: 3 + Math.floor(r() * 3) }, (_, k) => {
			const w = WORDS[Math.floor(r() * 23)]!;
			return k === 0 ? w : w[0]!.toUpperCase() + w.slice(1);
		}).join("") + pick(r, DIGIT10, Math.floor(r() * 3));
		let sha = 0;
		let cc = 0;
		for (let k = 0; k < 2_000; k++) {
			if (redact(Array.from({ length: 6 }, () => pick(r, HEX16, 7)).join("\n")).includes("[redacted:")) sha++;
			if (redact(Array.from({ length: 6 }, camel).join("\n")).includes("[redacted:")) cc++;
		}
		ctx.diagnostic(`short SHA lists ${pct(sha / 2_000)}, camelCase lists ${pct(cc / 2_000)}`);
	});

	it("fixed fixtures: ordinary wrapped prose and one-path-per-line lists are left unchanged", () => {
		const prose = [
			"The quick brown fox jumps over the lazy dog and keeps\nrunning until the end of the road, where it finally\nstops.",
			"> a quoted reply that wraps across\n> two lines of ordinary text",
			"│ box drawn output with words that │\n│ continue on the next line        │",
			"version 2.4.1 shipped on 2025-03-01 and  \nfixes 12 issues in the parser",
			"internationalization\nlocalization2024",
			"line one\r\nline two\r\n  indented three\rfour",
			"why does quicksort degrade to O(n^2) on sorted\ninput when the pivot is the first element?",
			"// a comment that wraps\n// onto the next line\n * and a doc line\n# heading text\n+ added line",
			"| name | count |\n|------|-------|\n| alpha | 12 |\n| beta2 | 340 |",
		];
		const lists = [
			"src/seed/redact.ts\nsrc/seed/egress.ts\nscripts/seed.ts",
			"/opt/work/client-x/app\n/opt/work/client-y/app\n/var/log/system.log",
			"./build/output-2025-03-01.tar.gz\n./build/output-2025-03-02.tar.gz",
			"C:\\work\\app\\main.ts\nC:\\work\\app\\util2.ts",
			"-opt-work-client-x-2025\n-opt-work-client-y-2026\n-opt-learn-notes-v2",
			"node_modules/.pnpm/fast-check@4.1.1/node_modules/fast-check\nnode_modules/.pnpm/typebox@1.0.0/node_modules/typebox",
		];
		for (const text of [...prose, ...lists]) assert.equal(redact(text), text);
	});
});
