/** Writes docs/architecture/schemas/<name>.json from the TypeBox line schemas; `--check` fails on drift. */
import fs from "node:fs";
import path from "node:path";
import { NodeLineSchema } from "../src/core/contracts/schemas/node-line.ts";
import { ChainLineSchema } from "../src/core/contracts/schemas/chain-line.ts";
import { CoverageLineExportSchema } from "../src/core/contracts/schemas/coverage-line.ts";
import { CheckpointLineSchema } from "../src/core/contracts/schemas/checkpoint-line.ts";
import { ReviewLineSchema, ReviewRemapLineSchema } from "../src/core/contracts/schemas/review-line.ts";

const SCHEMAS = { "node-line": NodeLineSchema, "chain-line": ChainLineSchema, "coverage-line": CoverageLineExportSchema, "checkpoint-line": CheckpointLineSchema, "review-line": ReviewLineSchema, "review-remap-line": ReviewRemapLineSchema };

const args = process.argv.slice(2);
const check = args.includes("--check");
const dirArg = args.indexOf("--dir");
const dir = path.resolve(dirArg >= 0 ? args[dirArg + 1]! : path.join(import.meta.dirname, "..", "docs", "architecture", "schemas"));
const want = new Map(Object.entries(SCHEMAS).map(([n, s]) => [`${n}.json`, `${JSON.stringify(s, null, "\t")}\n`]));

if (!check) {
	fs.mkdirSync(dir, { recursive: true });
	for (const [f, text] of want) fs.writeFileSync(path.join(dir, f), text);
} else {
	const have = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
	const bad = [
		...[...want].filter(([f, text]) => !have.includes(f) || fs.readFileSync(path.join(dir, f), "utf-8") !== text).map(([f]) => f),
		...have.filter((f) => !want.has(f)),
	];
	if (bad.length) {
		console.error(`check:schemas: drift in ${dir}: ${bad.join(", ")}. Run: tsx scripts/export-json-schemas.ts`);
		process.exit(1);
	}
	console.log(`check:schemas: ${want.size} schemas match`);
}
