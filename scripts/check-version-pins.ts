/**
 * check:pins: one DoltLite version. package.json's exact optionalDependency must equal the version
 * named in the header of tests/sql/engine-facts.doltlite.test.ts (spec: agent-guardrails).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXACT = /^\d+\.\d+\.\d+$/;
const HEADER = /^\s*\*\s*DoltLite version under test:\s*(\S+)\s*$/m;

/** Pure: one message per problem, empty when the pins agree. */
export function comparePins(dependency: string | undefined, factsSource: string | undefined): string[] {
	const problems: string[] = [];
	if (dependency === undefined) problems.push('package.json: optionalDependencies["@dolthub/doltlite"] is missing');
	else if (!EXACT.test(dependency)) problems.push(`package.json: @dolthub/doltlite is "${dependency}", it must be an exact x.y.z (no ^, ~, range or tag)`);
	const header = factsSource === undefined ? undefined : HEADER.exec(factsSource)?.[1];
	if (header === undefined) problems.push('engine-facts.doltlite.test.ts: header line " * DoltLite version under test: x.y.z" is missing');
	if (dependency !== undefined && header !== undefined && dependency !== header) {
		problems.push(`version mismatch: package.json pins @dolthub/doltlite ${dependency}, the engine-facts header says ${header}`);
	}
	return problems;
}

function main(): void {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { optionalDependencies?: Record<string, string> };
	const factsFile = path.join(root, "tests/sql/engine-facts.doltlite.test.ts");
	const facts = fs.existsSync(factsFile) ? fs.readFileSync(factsFile, "utf8") : undefined;
	const problems = comparePins(pkg.optionalDependencies?.["@dolthub/doltlite"], facts);
	if (problems.length > 0) {
		for (const problem of problems) console.error(`check:pins: ${problem}`);
		process.exit(1);
	}
	console.log(`check:pins: @dolthub/doltlite ${pkg.optionalDependencies?.["@dolthub/doltlite"]} matches the engine-facts header`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
