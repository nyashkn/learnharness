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
