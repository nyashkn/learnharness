/**
 * CB5: the TypeBox line schemas accept exactly what the hand guards in store/graph.ts accept.
 * Black-box: each generated ledger line is written as raw text to the real ledger file and the
 * matching graphStore.read*() runs the real guard ("line survived" = accepted). No guard copy.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import fc from "fast-check";
import { Value } from "typebox/value";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-line-schemas-"));
process.env.LH_DATA_DIR = dataDir; // config.ts binds this at import time
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
const { LEDGER_FILES } = await import("../config.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { NodeLineSchema } = await import("../src/core/contracts/schemas/node-line.ts");
const { ChainLineSchema } = await import("../src/core/contracts/schemas/chain-line.ts");
const { CoverageLineSchema } = await import("../src/core/contracts/schemas/coverage-line.ts");
const { CheckpointLineSchema } = await import("../src/core/contracts/schemas/checkpoint-line.ts");
const { ReviewLineSchema, ReviewRemapLineSchema } = await import("../src/core/contracts/schemas/review-line.ts");
const { lineCheck } = await import("../src/store/line-check.ts");

// ── raw JSON fragment generators (text, so 1e999 survives) ──
const str = fc.string({ maxLength: 8 }).map((s) => JSON.stringify(s));
const junk = fc.constantFrom("null", "1", "0", "-1", "true", "false", "{}", "[]", '[1]', '["a",null]', "1e999", "-1e999", '""', '{"a":1}');
const point = fc.oneof(
	{ weight: 4, arbitrary: fc.record({ c: str, m: str }).map(({ c, m }) => `{"chatId":${c},"messageId":${m}}`) },
	{ weight: 1, arbitrary: fc.constantFrom('{"chatId":"a"}', '{"messageId":"a"}', '{"chatId":1,"messageId":"a"}', '{"chatId":"a","messageId":null}', "null", '"a"', "[]", '{"chatId":"a","messageId":"b","x":1}') },
);
const arrOf = (m: fc.Arbitrary<string>, min = 0) => fc.array(m, { minLength: min, maxLength: 3 }).map((a) => `[${a.join(",")}]`);
const mostly = (good: fc.Arbitrary<string>, bad: fc.Arbitrary<string>) => fc.oneof({ weight: 6, arbitrary: good }, { weight: 1, arbitrary: bad });

const strField = mostly(str, junk);
const strArr = mostly(arrOf(str), fc.oneof(junk, arrOf(fc.oneof(str, junk), 1)));
const provArr = mostly(arrOf(point), fc.oneof(junk, arrOf(point, 1)));
const premArr = mostly(arrOf(str, 1), fc.oneof(junk, arrOf(fc.oneof(str, junk), 0)));
const numField = mostly(fc.oneof(fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => JSON.stringify(n)), fc.constantFrom("1e999", "-1e999", "0", "-0", "1e-999")), junk);

const extras = fc.array(
	fc.oneof(
		fc.tuple(fc.constantFrom("extra", "tags", "x-y", "__proto__", "constructor", "toString"), junk).map(([k, v]) => `${JSON.stringify(k)}:${v}`),
		fc.constant('"__proto__":{"id":"zzz"}'),
	),
	{ maxLength: 2 },
);

/** An object line: each field is dropped (small chance) or taken from its fragment generator. */
function lineOf(fields: Record<string, fc.Arbitrary<string>>): fc.Arbitrary<string> {
	const keys = Object.keys(fields);
	return fc
		.tuple(fc.tuple(...keys.map((k) => fc.oneof({ weight: 12, arbitrary: fields[k]!.map((v) => `${JSON.stringify(k)}:${v}`) }, { weight: 1, arbitrary: fc.constant("") }))), extras, fc.constantFrom("", " ", "\t"))
		.map(([parts, ex, pad]) => `${pad}{${[...parts, ...ex].filter(Boolean).join(",")}}${pad}`);
}
const nonObject = fc.constantFrom("null", "1", "-1e999", '"str"', "true", "[]", "[1]", '[{"id":"a"}]', "{}");
const withNonObjects = (obj: fc.Arbitrary<string>) => fc.oneof({ weight: 20, arbitrary: obj }, { weight: 1, arbitrary: nonObject });

const KINDS = [
	{ name: "node", file: LEDGER_FILES.nodes, schema: NodeLineSchema, read: () => graphStore.readNodes(), line: lineOf({ id: strField, name: strField, statement: strField, aliases: strArr, createdAt: strField, provenance: provArr }) },
	{ name: "chain", file: LEDGER_FILES.chains, schema: ChainLineSchema, read: () => graphStore.readChains(), line: lineOf({ id: strField, premises: premArr, conclusion: strField, provenance: provArr, createdAt: strField }) },
	{ name: "coverage", file: LEDGER_FILES.coverage, schema: CoverageLineSchema, read: () => graphStore.readCoverage(), line: lineOf({ chatId: strField, fp: strField, tokens: numField, foldedAt: strField }) },
	{ name: "checkpoint", file: LEDGER_FILES.sessions, schema: CheckpointLineSchema, read: () => graphStore.readCheckpoints(), line: lineOf({ chatId: strField, foldedAt: strField }) },
] as const;

describe("line schemas accept exactly what the graph.ts guards accept", () => {
	for (const k of KINDS) {
		it(`${k.name}: parity over 10,000 raw lines, non-vacuous`, () => {
			fs.mkdirSync(path.dirname(k.file), { recursive: true });
			let accepted = 0, rejected = 0;
			fc.assert(
				fc.property(withNonObjects(k.line), (text) => {
					fs.writeFileSync(k.file, `${text}\n`);
					const guardSays = k.read().length === 1;
					const schemaSays = Value.Check(k.schema, JSON.parse(text));
					if (guardSays) accepted++; else rejected++;
					return guardSays === schemaSays;
				}),
				{ numRuns: 10_000 },
			);
			assert.ok(accepted >= 1000 && rejected >= 1000, `accepted=${accepted} rejected=${rejected}`);
		});
	}

	it("a line that fails JSON.parse is skipped by the reader (outside the schema's domain, so excluded from parity)", () => {
		fs.writeFileSync(LEDGER_FILES.sessions, '{"chatId":"a","foldedAt":"b"\n');
		assert.deepEqual(graphStore.readCheckpoints(), []);
	});

	it("1e999 parses to Infinity and both sides accept it", () => {
		fs.writeFileSync(LEDGER_FILES.coverage, '{"chatId":"a","fp":"b","tokens":1e999,"foldedAt":"c"}\n');
		assert.equal(graphStore.readCoverage().length, 1);
		assert.ok(Value.Check(CoverageLineSchema, { chatId: "a", fp: "b", tokens: Infinity, foldedAt: "c" }));
	});
});

// Review lines are not read by graph.ts guards, so they only feed the lineCheck-vs-Value.Check property below.
const reviewOutcome = mostly(fc.constantFrom('"solved"', '"solvedWithHints"', '"movedOn"', '"surrendered"', '"dismissed"'), junk);
const reviewRung = mostly(fc.constantFrom('"R0"', '"R1"', '"R2"', '"R3"', '"R4"', '"R5"', "null"), junk);
const reviewMode = mostly(fc.constantFrom('"recall"', '"discrimination"', '"composition"'), junk);
const reviewMissClass = mostly(fc.constantFrom('"cue"', '"discrimination"', '"execution"', '"careless"', '"structural"', "null"), junk);
const confidence = mostly(fc.integer({ min: 0, max: 100 }).map(String), fc.constantFrom("-1", "101", "100.5", "-0.5", "1e999", "null"));
const REVIEW = lineOf({
	id: strField, chatId: strField, problemCallId: strField, at: strField, targets: premArr, outcome: reviewOutcome,
	rung: reviewRung, mode: reviewMode, missClass: reviewMissClass, surface: strField, confidence,
});
const REMAP = lineOf({ from: strField, to: strField });

/** Every line schema, paired with a generator of raw lines that mixes valid and junk values. */
const PARITY_SCHEMAS = [
	...KINDS.map((k) => ({ name: k.name, schema: k.schema, line: k.line })),
	{ name: "review", schema: ReviewLineSchema, line: REVIEW },
	{ name: "review-remap", schema: ReviewRemapLineSchema, line: REMAP },
];

describe("lineCheck (compiled, used by the stores) agrees with Value.Check (interpreted)", () => {
	for (const s of PARITY_SCHEMAS) {
		it(`${s.name}: verdicts match over 1,000 raw lines, both verdicts occur`, () => {
			let accepted = 0, rejected = 0;
			fc.assert(
				fc.property(withNonObjects(s.line), (text) => {
					let v: unknown;
					try { v = JSON.parse(text); } catch { return true; } // unparsable text is outside the schema's domain
					const compiled = lineCheck(s.schema, v);
					if (compiled) accepted++; else rejected++;
					return compiled === Value.Check(s.schema, v);
				}),
				{ numRuns: 1_000 },
			);
			// Measured over seeds 1-200 (lh-5rw): the lowest count of either verdict was review's accepted, 85-144 (mean ~115, sd ~10).
			// 30 is far below that, so it never flakes, and still fails a generator that drifts to all-reject or all-accept.
			assert.ok(accepted >= 30 && rejected >= 30, `accepted=${accepted} rejected=${rejected}`);
		});
	}
});

describe("check:schemas drift", () => {
	const script = path.resolve(import.meta.dirname, "../scripts/export-json-schemas.ts");
	const real = path.resolve(import.meta.dirname, "../docs/architecture/schemas");
	const run = (...a: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, ...a], { encoding: "utf-8" });
	const copy = () => { const d = fs.mkdtempSync(path.join(dataDir, "schemas-")); fs.cpSync(real, d, { recursive: true }); return d; };

	it("exported coverage-line.json types tokens as number", () => {
		const j = JSON.parse(fs.readFileSync(path.join(real, "coverage-line.json"), "utf-8"));
		assert.equal(j.properties.tokens.type, "number");
	});
	it("passes on the committed files", () => assert.equal(run("--check").status, 0));
	it("fails on an edited file", () => {
		const d = copy();
		fs.appendFileSync(path.join(d, "node-line.json"), " ");
		assert.notEqual(run("--check", "--dir", d).status, 0);
	});
	it("fails on a missing file", () => {
		const d = copy();
		fs.rmSync(path.join(d, "chain-line.json"));
		assert.notEqual(run("--check", "--dir", d).status, 0);
	});
	it("fails on a stray file", () => {
		const d = copy();
		fs.writeFileSync(path.join(d, "stray.json"), "{}\n");
		assert.notEqual(run("--check", "--dir", d).status, 0);
	});
	it("a no-flag run regenerates a clean dir that then passes --check", () => {
		const d = fs.mkdtempSync(path.join(dataDir, "schemas-"));
		assert.equal(run("--dir", d).status, 0);
		assert.equal(run("--check", "--dir", d).status, 0);
	});
});
