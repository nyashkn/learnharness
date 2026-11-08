import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import fc from "fast-check";
import { clipSnippet, createAllowEgress, MAX_SNIPPET_CHARS } from "../../src/seed/egress";
import { redact } from "../../src/seed/redact";
import { findRepeats, tagSignal } from "../../src/seed/signals";
import { claudeHistorySource } from "../../src/seed/sources/claude-history";
import { harvest } from "../../src/seed/sources/harvest";
import { ompHistorySource, ompMemorySource, ompRecapSource } from "../../src/seed/sources/omp";
import { signetSummarySource } from "../../src/seed/sources/signet";
import type { HarvestItem, ReadOnlyDb, ReadOnlyFiles, SessionSource } from "../../src/seed/types";

// ---- fake ports -----------------------------------------------------------

type Rows = Record<string, Record<string, unknown>[]>;

function fakeDb(tables: Rows) {
	const statements: string[] = [];
	const db: ReadOnlyDb = {
		async all(sql, params) {
			statements.push(sql);
			const table = /\bFROM\s+(\w+)/i.exec(sql)?.[1] ?? "";
			const rows = tables[table] ?? [];
			// the only filter the fake honours: the entities popularity threshold
			if (table === "entities" && typeof params?.[0] === "number") {
				const min = params[0];
				return rows.filter((row) => typeof row.mentions !== "number" || row.mentions >= min);
			}
			return rows;
		},
	};
	return { db, statements };
}

function fakeFiles(files: Record<string, string>): ReadOnlyFiles {
	return {
		async *lines(path) {
			for (const line of (files[path] ?? "").split("\n")) yield line;
		},
		async read(path) {
			const text = files[path];
			if (text === undefined) throw new Error("ENOENT");
			return text;
		},
		async list(dir) {
			const prefix = `${dir}/`;
			return [...new Set(Object.keys(files).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0] as string))];
		},
		async mtime() {
			return new Date("2026-03-01T00:00:00.000Z");
		},
	};
}

const T = 1_760_000_000; // seconds
const ISO = "2026-03-01T00:00:00.000Z";

/** One valid input per adapter input, all carrying `text`; 7 items expected. */
function allSources(text: string, project: string, memorySlug = "plain-slug") {
	const history = fakeDb({ history: [{ id: 1, prompt: text, created_at: T, cwd: project, session_id: "s1" }] });
	const recapDb = fakeDb({ session_recaps: [{ id: 1, session_id: "s2", cwd: project, recap: text, created_at: T }] });
	const agent = fakeDb({ stage1_outputs: [{ thread_id: "t1", generated_at: T, rollout_summary: text, cwd: project }] });
	const signet = fakeDb({
		session_summaries: [{ id: "x1", project, content: text, latest_at: ISO, session_key: "k1" }],
		entities: [{ id: "e1", name: "concept", description: text, updated_at: ISO, mentions: 9 }],
	});
	const files = fakeFiles({
		"/h/history.jsonl": JSON.stringify({ display: text, pastedContents: {}, timestamp: T * 1000, project, sessionId: "s0" }),
		[`/mem/${memorySlug}/learned.md`]: text,
	});
	const dbs = [history, recapDb, agent, signet];
	const sources: SessionSource[] = [
		claudeHistorySource({ files, path: "/h/history.jsonl" }),
		ompHistorySource(history.db),
		ompRecapSource(recapDb.db),
		ompMemorySource({ agentDb: agent.db, files, memoriesDir: "/mem" }),
		signetSummarySource({ db: signet.db, minMentions: 3 }),
	];
	return { sources, statements: () => dbs.flatMap((d) => d.statements) };
}

async function collect(sources: SessionSource[]): Promise<HarvestItem[]> {
	const out: HarvestItem[] = [];
	for await (const item of harvest(sources)) out.push(item);
	return out;
}

// ---- generators built from documented token formats, not from the redactor ----

const ALNUM = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
const UPPER_DIGIT = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
const HEX = [..."0123456789abcdef"];
const DIGITS = [..."0123456789"];
const chars = (set: string[], min: number, max = min) => fc.array(fc.constantFrom(...set), { minLength: min, maxLength: max }).map((a) => a.join(""));
const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");

interface Planted {
	kind: string;
	/** the full string placed in the text */
	text: string;
	/** substrings that must not survive */
	secrets: string[];
	/** line-anchored kinds need a newline before them */
	ownLine?: boolean;
}

const planted: fc.Arbitrary<Planted> = fc.oneof(
	chars(ALNUM, 24, 48).map((b) => ({ kind: "sk", text: `sk-${b}`, secrets: [b] })),
	chars([...ALNUM, "_", "-"], 30, 60).map((b) => ({ kind: "sk-ant", text: `sk-ant-api03-${b}`, secrets: [b] })),
	chars(HEX, 40, 64).map((b) => ({ kind: "sk-or", text: `sk-or-v1-${b}`, secrets: [b] })),
	fc.tuple(fc.constantFrom("ghp", "gho", "ghs"), chars(ALNUM, 36)).map(([p, b]) => ({ kind: p, text: `${p}_${b}`, secrets: [b] })),
	chars([...ALNUM, "_"], 40, 82).map((b) => ({ kind: "github_pat", text: `github_pat_${b}`, secrets: [b] })),
	fc.tuple(fc.string({ minLength: 3, maxLength: 10, unit: fc.constantFrom(...ALNUM) }), chars([...ALNUM, "_", "-"], 20, 43)).map(([sub, sig]) => {
		const payload = b64url({ sub, iat: 1_700_000_000 });
		return { kind: "jwt", text: `${b64url({ alg: "HS256", typ: "JWT" })}.${payload}.${sig}`, secrets: [payload, sig] };
	}),
	fc
		.tuple(fc.constantFrom("API_KEY", "DB_PASSWORD", "SECRET_TOKEN", "OPENAI_API_KEY", "XY"), chars(ALNUM, 12, 30), fc.boolean())
		.map(([name, value, exp]) => ({ kind: "env", text: `${exp ? "export " : ""}${name}=${value}`, secrets: [value], ownLine: true })),
	chars([...ALNUM, ".", "_", "-"], 20, 60).map((t) => ({ kind: "bearer", text: `Authorization: Bearer ${t}`, secrets: [t] })),
	chars(UPPER_DIGIT, 16).map((b) => ({ kind: "aws", text: `AKIA${b}`, secrets: [`AKIA${b}`] })),
	fc.tuple(chars(DIGITS, 11), chars(DIGITS, 12), chars(ALNUM, 24)).map(([a, b, c]) => ({ kind: "slack", text: `xoxb-${a}-${b}-${c}`, secrets: [c] })),
	chars([...ALNUM, "+", "/"], 40, 64).map((body) => ({
		kind: "pem",
		text: `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`,
		secrets: [body],
	})),
	fc.tuple(chars(ALNUM, 6, 12), chars(ALNUM, 5, 10)).map(([l, d]) => ({ kind: "email", text: `${l}@${d}.com`, secrets: [`${l}@${d}.com`, l] })),
	fc.tuple(chars(ALNUM, 12, 24), fc.constantFrom("token", "key", "code")).map(([v, k]) => ({ kind: "url-query", text: `https://example.com/cb?${k}=${v}`, secrets: [v] })),
	fc.tuple(chars(ALNUM, 12, 24), chars(ALNUM, 6, 10)).map(([pw, user]) => ({ kind: "url-creds", text: `https://${user}:${pw}@git.example.com/repo`, secrets: [pw] })),
	chars(ALNUM, 5, 10).map((n) => ({ kind: "home-path", text: `/Users/usr${n}/code/app`, secrets: [`usr${n}`] })),
);

const SEPARATORS = [" ", "\n", "(", '"', ": ", "'"];
const noise = fc.constantFrom("please look at this", "here is the log", "I tried it and", "my notes say", "");
const embed = fc.tuple(noise, fc.constantFrom(...SEPARATORS), planted, fc.constantFrom(" ", "\n", ")", '"', ". ", ""), noise).map(([a, sep, p, end, b]) => {
	const lead = p.ownLine ? "\n" : sep;
	return { p, text: `${a}${lead}${p.text}${end}${b}` };
});

// ---- (1) secrets never survive, in every source ----

describe("redaction through harvest()", () => {
	it("no planted secret survives in any source's text or project", async () => {
		await fc.assert(
			fc.asyncProperty(embed, chars(ALNUM, 5, 10), async ({ p, text }, user) => {
				const project = `/Users/usr${user}/code/app`;
				const { sources } = allSources(text, project, `-Users-usr${user}-code-app`);
				const items = await collect(sources);
				assert.equal(items.length, 7, "one item per adapter input");
				for (const item of items) {
					for (const secret of [...p.secrets, `usr${user}`]) {
						assert.ok(!item.textRedacted.includes(secret), `${item.source}: ${p.kind} survived in text`);
						assert.ok(!(item.project ?? "").includes(secret), `${item.source}: ${secret} survived in project`);
					}
				}
				assert.deepEqual(
					new Set(items.map((i) => i.source)),
					new Set(["claude-history", "omp-history", "omp-recap", "omp-memory", "signet-summary"]),
				);
			}),
			{ numRuns: 200 },
		);
	});

	it("(2) redact is idempotent, on noise and on planted secrets", () => {
		fc.assert(fc.property(fc.string({ unit: "binary", maxLength: 300 }), (s) => redact(redact(s)) === redact(s)));
		fc.assert(fc.property(embed, ({ text }) => redact(redact(text)) === redact(text)));
	});

	const SAFE = [
		"x = n^2",
		"N=5",
		"O(n log n)",
		"why does quicksort degrade to O(n^2) on sorted input?",
		"the integral of 1/x is ln|x| + C",
		"f(x) = 2x + 1; solve for x",
		"see https://en.wikipedia.org/wiki/Monad_(functional_programming) for details",
		"a/b = c/d, so ad = bc",
		"the bearer of bad news",
		"sk-learn style notes: risk-adjusted returns",
	];

	it("(3) maths and prose survive redaction unchanged", () => {
		fc.assert(
			fc.property(fc.constantFrom(...SAFE), fc.constantFrom(" ", "\n"), fc.constantFrom(...SAFE), (a, sep, b) => redact(`${a}${sep}${b}`) === `${a}${sep}${b}`),
		);
	});

	it("(3) non-code questions get a signal; neutral text gets none", () => {
		const cues = ["explain", "eli5", "why does", "what is a", "I don't understand", "what is an"];
		const topics = ["eigenvalues", "quicksort degrade on sorted input", "a monad", "the central limit theorem", "big-O notation", "backpropagation"];
		fc.assert(fc.property(fc.constantFrom(...cues), fc.constantFrom(...topics), (c, t) => tagSignal(`${c} ${t}`) === "confusion"));
		assert.equal(tagSignal("so confusing??"), "confusion");
		assert.equal(tagSignal("should we use Postgres or SQLite"), "decision");
		assert.equal(tagSignal("postgres vs sqlite for this"), "decision");
		assert.equal(tagSignal("just do it, I trust you"), "delegated");
		assert.equal(tagSignal("rename the variable foo to bar and commit"), null);
		assert.equal(tagSignal("x = n^2"), null);
	});

	it("repeat: same normalised text in 3+ distinct sessions", () => {
		const mk = (id: string, sessionId: string, text: string) => ({ id, sessionId, text });
		const three = findRepeats([mk("a", "s1", "What is a Monad?"), mk("b", "s2", "what is a monad"), mk("c", "s3", "WHAT IS A MONAD!!")]);
		assert.deepEqual([...three].sort(), ["a", "b", "c"]);
		assert.equal(findRepeats([mk("a", "s1", "x y"), mk("b", "s2", "x y")]).size, 0);
		assert.equal(findRepeats([mk("a", "s1", "x y"), mk("b", "s1", "x y"), mk("c", "s1", "x y")]).size, 0);
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 6 }), (n) => {
				const items = Array.from({ length: n }, (_, i) => mk(`i${i}`, `s${i}`, "same question"));
				return (findRepeats(items).size > 0) === (n >= 3);
			}),
		);
	});
});

// ---- (4) malformed input ----

describe("malformed rows and lines", () => {
	const MARK = "MALFORMED_MARKER_q9z";
	const badLines = [
		`{not json ${MARK}`,
		JSON.stringify({ display: 5, timestamp: 1, project: "/p", sessionId: "s", note: MARK }),
		JSON.stringify({ display: MARK, timestamp: "late", project: "/p", sessionId: "s" }),
		JSON.stringify({ display: MARK, timestamp: 1e30, project: "/p", sessionId: "s" }),
		JSON.stringify([MARK]),
		JSON.stringify({ display: MARK }),
	];
	const badHistory = [
		{ id: "one", prompt: MARK, created_at: T, cwd: null, session_id: null },
		{ id: 2, prompt: null, created_at: T, cwd: MARK, session_id: null },
		{ id: 3, prompt: MARK, created_at: 1e30, cwd: null, session_id: null },
		{ id: 4, prompt: MARK },
	];
	const good = { id: 9, prompt: "explain eigenvalues", created_at: T, cwd: "/work/a", session_id: "s9" };

	it("are skipped and counted; their content reaches no output and no console", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => mock.method(console, m, () => {}));
		try {
			await fc.assert(
				fc.asyncProperty(fc.subarray(badLines, { minLength: 1 }), fc.subarray(badHistory, { minLength: 1 }), async (bl, bh) => {
					const goodLine = JSON.stringify({ display: "why does quicksort degrade", timestamp: T * 1000, project: "/work/a", sessionId: "s1" });
					const files = fakeFiles({ "/h.jsonl": ["", ...bl, goodLine, "   "].join("\n") });
					const cc = claudeHistorySource({ files, path: "/h.jsonl" });
					const omp = ompHistorySource(fakeDb({ history: [...bh, good] }).db);
					const out = await collect([cc, omp]);
					assert.equal(out.length, 2);
					assert.equal(cc.stats.skipped, bl.length, "claude-history skipped count");
					assert.equal(omp.stats.skipped, bh.length, "omp-history skipped count");
					assert.ok(!JSON.stringify(out).includes(MARK));
				}),
				{ numRuns: 60 },
			);
			for (const spy of spies) assert.ok(!JSON.stringify(spy.mock.calls).includes(MARK));
		} finally {
			mock.restoreAll();
		}
	});

	it("bad rows in recap, memory and signet are skipped and counted too", async () => {
		const recap = ompRecapSource(fakeDb({ session_recaps: [{ id: 1, session_id: 5, cwd: null, recap: MARK, created_at: T }] }).db);
		const mem = ompMemorySource({
			agentDb: fakeDb({ stage1_outputs: [{ thread_id: "t", generated_at: "x", rollout_summary: MARK, cwd: null }] }).db,
			files: fakeFiles({}),
			memoriesDir: "/mem",
		});
		const sig = signetSummarySource({
			db: fakeDb({
				session_summaries: [{ id: "a", project: null, content: MARK, latest_at: "not a date", session_key: null }],
				entities: [{ id: "e", name: MARK, description: null, updated_at: "2026-01-01T00:00:00Z", mentions: "many" }],
			}).db,
			minMentions: 0,
		});
		const out = await collect([recap, mem, sig]);
		assert.equal(out.length, 0);
		assert.deepEqual([recap.stats.skipped, mem.stats.skipped, sig.stats.skipped], [1, 1, 2]);
	});
});

// ---- (5) read-only ----

describe("read-only adapters", () => {
	it("every SQL statement is a single SELECT", async () => {
		const { sources, statements } = allSources("explain eigenvalues", "/work/a");
		await collect(sources);
		const all = statements();
		assert.ok(all.length >= 5);
		for (const sql of all) {
			assert.match(sql, /^\s*SELECT\b/i);
			assert.ok(!sql.includes(";"), "no statement chaining");
		}
	});

	it("entities below minMentions are not read in", async () => {
		const db = fakeDb({
			entities: [
				{ id: "lo", name: "rare", description: null, updated_at: ISO, mentions: 2 },
				{ id: "hi", name: "common", description: "a concept", updated_at: ISO, mentions: 3 },
			],
		}).db;
		const out = await collect([signetSummarySource({ db, minMentions: 3 })]);
		assert.deepEqual(out.map((i) => i.textRedacted), ["common\na concept"]);
	});
});

// ---- (6) egress ----

describe("allowEgress", () => {
	it("defaults to true for every project, null included", () => {
		fc.assert(fc.property(fc.option(fc.string(), { nil: null }), (p) => createAllowEgress([])(p) === true));
	});
	it("blocks opt-out entries by case-insensitive substring", () => {
		const allow = createAllowEgress(["DockBlocks", "pivot"]);
		assert.equal(allow("~/work/dockblocks/web"), false);
		assert.equal(allow("~/work/DOCKBLOCKS-wt2"), false);
		assert.equal(allow("-Users-x-Pivot-planit"), false);
		assert.equal(allow("~/work/learn-harness"), true);
		assert.equal(allow(null), true);
	});
	it("ignores blank entries instead of blocking everything", () => {
		assert.equal(createAllowEgress([""," "])("~/anything"), true);
	});
	it("clips snippets to the cap", () => {
		assert.equal(MAX_SNIPPET_CHARS, 300);
		assert.equal(clipSnippet("a".repeat(500)).length, 300);
		assert.equal(clipSnippet("short"), "short");
	});
});

// ---- (7) username never in project ----

describe("project normalisation", () => {
	it("no path or slug form keeps the username", async () => {
		await fc.assert(
			fc.asyncProperty(chars(ALNUM, 5, 10), async (n) => {
				const name = `usr${n}`;
				const forms: [string, string][] = [
					[`/Users/${name}/code/app`, "~/code/app"],
					[`/home/${name}/code/app`, "~/code/app"],
					[`C:\\Users\\${name}\\code\\app`, "~\\code\\app"],
					[`-Users-${name}-code-app`, "~-code-app"],
				];
				for (const [project, expected] of forms) {
					// path forms arrive as cwd in the db sources; the slug form also arrives as a learned.md folder name
					const items = await collect(allSources("a note", project, project.startsWith("-") ? project : "plain-slug").sources);
					const withProject = items.filter((i) => i.project !== null && !(i.source === "omp-memory" && i.sessionId === null && !project.startsWith("-")));
					assert.ok(withProject.length >= 4, project);
					for (const item of withProject) {
						assert.ok(!item.project?.includes(name), `${item.source}: ${project}`);
						assert.equal(item.project, expected, `${item.source}: ${project}`);
					}
				}
			}),
		);
	});
});

// ---- (8) pastedContents ----

describe("claude-history", () => {
	it("never reads pastedContents", async () => {
		const MARK = "PASTED_MARKER_k3v";
		const line = JSON.stringify({
			display: "explain eigenvalues",
			pastedContents: { 1: { id: 1, type: "text", content: MARK } },
			timestamp: T * 1000,
			project: "/work/a",
			sessionId: "s1",
		});
		const out = await collect([claudeHistorySource({ files: fakeFiles({ "/h": line }), path: "/h" })]);
		assert.equal(out.length, 1);
		assert.ok(!JSON.stringify(out).includes(MARK));
	});

	it("reads the synthetic fixture: 3 prompts, 1 truncated line skipped", async () => {
		const text = readFileSync(join(import.meta.dirname, "../fixtures/seed/claude-history.sample.jsonl"), "utf8");
		const src = claudeHistorySource({ files: fakeFiles({ "/h": text }), path: "/h" });
		const out = await collect([src]);
		assert.deepEqual(out.map((i) => i.signal), ["confusion", "confusion", "confusion"]);
		assert.equal(src.stats.skipped, 1);
	});
});

// ---- (9) fixture guard ----

describe("fixtures", () => {
	it("hold no real username and no home path", () => {
		const dir = join(import.meta.dirname, "../fixtures/seed");
		const name = userInfo().username.toLowerCase();
		const files = readdirSync(dir);
		assert.ok(files.length > 0);
		for (const f of files) {
			const body = readFileSync(join(dir, f), "utf8");
			assert.ok(!body.toLowerCase().includes(name), `${f} contains the machine username`);
			assert.ok(!/\/Users\/|\/home\/|[A-Za-z]:\\Users\\/.test(body), `${f} contains a home path`);
		}
	});
});
