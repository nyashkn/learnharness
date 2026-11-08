/**
 * Composition root for cold-start seeding (CB7): the only place src/seed meets the SQL driver, the settings and the network.
 *   pnpm run seed -- scan|list|label|propose|report   (see --help)
 * Stores and sources are built after the command parses, so --help opens nothing.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { PATHS } from "../config.ts";
import { HELP, parseCommand, runCli, type SeedPolicy } from "../src/seed/cli.ts";
import { canonProject, createAllowEgress } from "../src/seed/egress.ts";
import { createConfiguredLlmJudge } from "../src/seed/judge/configured-llm.ts";
import { createJevApiJudge, type ProfileName } from "../src/seed/judge/jev-api.ts";
import type { JudgePort } from "../src/seed/judge/port.ts";
import { claudeHistorySource } from "../src/seed/sources/claude-history.ts";
import { ompHistorySource, ompMemorySource, ompRecapSource } from "../src/seed/sources/omp.ts";
import { signetSummarySource } from "../src/seed/sources/signet.ts";
import { createSeedStore } from "../src/seed/store.ts";
import type { AllowEgress, LlmPort, ReadOnlyDb, ReadOnlyFiles, SessionSource } from "../src/seed/types.ts";
import type { SqlDriver } from "../src/store/sql/driver.ts";
import { openNodeSqlite } from "../src/store/sql/drivers/node-sqlite.ts";
import { MigrationRefusedError, migrate } from "../src/store/sql/migrate.ts";
import { seedMigration } from "../src/store/sql/migrations/seeds/index.ts";

const SeedConfig = Type.Object(
	{
		calibrated: Type.Boolean(),
		recencyHalfLifeDays: Type.Number({ exclusiveMinimum: 0 }),
		goalWeight: Type.Number(),
		minMentions: Type.Number({ minimum: 0 }),
		learnableTau: Type.Number({ minimum: 0, maximum: 1 }),
	},
	{ additionalProperties: false },
);

/** Trust boundary (ADR 0008). No fallback numbers: a missing or malformed file aborts. */
export function loadSeedConfig(file: string, read: (file: string) => string = (f) => readFileSync(f, "utf8")): SeedPolicy {
	let json: unknown;
	try {
		json = JSON.parse(read(file));
	} catch {
		throw new Error(`cannot read rank config ${file}: it must exist and be valid JSON`);
	}
	if (!Value.Check(SeedConfig, json)) {
		const first = [...Value.Errors(SeedConfig, json)][0];
		throw new Error(`rank config ${file} is invalid: ${first?.instancePath || "(root)"} ${first?.message ?? ""}`.trim());
	}
	return json;
}

/**
 * Default-on egress holds with an empty opt-out list. With any entry, a null project is refused:
 * Signet entities and cwd-less rows carry no provenance, so we cannot prove they are not opted-out work.
 */
export function composeAllowEgress(optOut: readonly string[]): AllowEgress {
	const inner = createAllowEgress(optOut);
	const listed = optOut.some((entry) => canonProject(entry) !== "");
	return (project) => (project === null || canonProject(project) === "" ? !listed : inner(project));
}

export function parseOptOut(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

/** ENOENT is an empty list; any other failure propagates, because a list we could not read must not mean "allow all". */
export async function readOptOut(file: string, read: (file: string) => Promise<string> = (f) => readFile(f, "utf8")): Promise<string[]> {
	try {
		return parseOptOut(await read(file));
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw error;
	}
}

const JUDGES: readonly string[] = ["clef", "typesafe", "openrouter", "configured-llm"];

export interface Factories {
	dataDir: string;
	lhVersion: () => string;
	openStore: (file: string) => SqlDriver;
	configFile: string;
	buildSources: (opts: { minMentions: number; out: (line: string) => void }) => { sources: SessionSource[]; close: () => void };
	buildLlm: () => Promise<LlmPort>;
	readOptOut: (file: string) => Promise<string[]>;
	env: (name: string) => string | undefined;
	fetch: typeof fetch;
	out: (line: string) => void;
	now: () => string;
	newId: () => string;
}

function takeFlag(argv: string[], name: string): string | undefined | "missing" {
	const at = argv.indexOf(name);
	if (at < 0) return undefined;
	const value = argv[at + 1];
	if (value === undefined || value.startsWith("--")) return "missing";
	argv.splice(at, 2);
	return value;
}

export async function main(rawArgv: readonly string[], overrides: Partial<Factories> = {}): Promise<number> {
	const f: Factories = { ...defaultFactories(), ...overrides };
	const argv = rawArgv[0] === "--" ? [...rawArgv.slice(1)] : [...rawArgv];
	const judgeName = takeFlag(argv, "--judge");
	const url = takeFlag(argv, "--url");
	if (judgeName === "missing" || url === "missing") {
		f.out("--judge and --url each need a value");
		return 2;
	}
	if (judgeName !== undefined && !JUDGES.includes(judgeName)) {
		f.out(`unknown judge: ${judgeName}`);
		return 2;
	}

	const parsed = parseCommand(argv);
	if (parsed.kind === "help") {
		f.out(HELP);
		return 0;
	}
	if (parsed.kind === "error") {
		f.out(parsed.message);
		return 2;
	}

	let policy: SeedPolicy;
	try {
		policy = loadSeedConfig(f.configFile);
	} catch (error) {
		f.out((error as Error).message);
		return 1;
	}

	let optOut: string[];
	try {
		optOut = await f.readOptOut(path.join(f.dataDir, "seed-optout.txt"));
	} catch {
		f.out("cannot read seed-optout.txt: refusing to run without knowing the opt-out list");
		return 1;
	}
	if (parsed.kind === "scan" || parsed.kind === "propose") {
		// data/ is per-worktree, so a list kept elsewhere reads as "allow all": say which file was used before anything leaves.
		const file = path.resolve(f.dataDir, "seed-optout.txt");
		f.out(optOut.length === 0 && !existsSync(file) ? `opt-out: 0 entries, file not found at ${file}` : `opt-out: ${optOut.length} entries from ${file}`);
	}
	const allowEgress = composeAllowEgress(optOut);

	const db = f.openStore(path.join(f.dataDir, "seeds.sqlite"));
	let closeSources = () => {};
	try {
		try {
			migrate(db, { ...seedMigration, lhVersion: f.lhVersion() });
		} catch (error) {
			if (error instanceof MigrationRefusedError) {
				f.out(`seeds.sqlite refused: ${error.message}`);
				return 1;
			}
			throw error;
		}
		const store = createSeedStore(db);

		// Built on first use: only scan and the configured-llm judge ever reach a model.
		let llmPromise: Promise<LlmPort> | undefined;
		const llm: LlmPort = {
			complete: async (prompt, schema) => {
				llmPromise ??= f.buildLlm();
				try {
					return await (await llmPromise).complete(prompt, schema);
				} catch (error) {
					if (error instanceof LlmUnavailableError) f.out(error.message);
					throw error;
				}
			},
		};

		const name = judgeName ?? "clef";
		const judge: JudgePort =
			name === "configured-llm"
				? createConfiguredLlmJudge({ llm, allowEgress, cache: store.judgmentCache(), now: f.now })
				: createJevApiJudge({ profile: name as ProfileName, allowEgress, cache: store.judgmentCache(), fetch: f.fetch, env: f.env, now: f.now });

		let sources: SessionSource[] = [];
		if (parsed.kind === "scan") {
			const built = f.buildSources({ minMentions: policy.minMentions, out: f.out });
			sources = built.sources;
			closeSources = built.close;
		}
		return await runCli(argv, {
			store,
			sources,
			judge,
			llm,
			allowEgress,
			fetch: f.fetch,
			baseUrl: (url ?? "http://localhost:3000").replace(/\/+$/, ""),
			now: f.now,
			newId: f.newId,
			out: f.out,
			policy,
		});
	} finally {
		closeSources();
		db.close();
	}
}

// ---- real factories ------------------------------------------------------------------------------------------------

class LlmUnavailableError extends Error {}

function defaultFactories(): Factories {
	return {
		dataDir: PATHS.data,
		configFile: path.join(PATHS.root, "scripts", "seed-config.json"),
		lhVersion: () => (JSON.parse(readPackageJson()) as { version: string }).version,
		openStore: (file) => {
			mkdirSync(path.dirname(file), { recursive: true });
			return openNodeSqlite(file);
		},
		buildSources: realSources,
		buildLlm: realLlm,
		readOptOut: (file) => readOptOut(file),
		env: (name) => process.env[name],
		fetch: (...args) => fetch(...args),
		out: (line) => console.log(line),
		now: () => new Date().toISOString(),
		newId: () => crypto.randomUUID(),
	};
}

function readPackageJson(): string {
	return readFileSync(path.join(PATHS.root, "package.json"), "utf8");
}

function readOnlyDb(file: string, closers: (() => void)[]): ReadOnlyDb {
	const db = openNodeSqlite(file, { readOnly: true });
	closers.push(() => db.close());
	return { all: async (sql, params = []) => db.all<Record<string, unknown>>(sql, ...params) };
}

const realFiles: ReadOnlyFiles = {
	async *lines(file) {
		const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
		for await (const line of rl) yield line;
	},
	read: (file) => readFile(file, "utf8"),
	list: (dir) => readdir(dir).catch((e: { code?: string }) => (e.code === "ENOENT" ? [] : Promise.reject(e))),
	mtime: async (file) => (await stat(file)).mtime,
};

/** Locations confirmed by schema-only queries (lead, 2026-11-08). A missing store is skipped and counted; any other open error aborts. */
function realSources({ minMentions, out }: { minMentions: number; out: (line: string) => void }) {
	const home = homedir();
	const closers: (() => void)[] = [];
	const sources: SessionSource[] = [];
	const omp = path.join(home, ".omp", "agent");
	const claudeHistory = path.join(home, ".claude", "history.jsonl");
	const present = (label: string, file: string) => {
		if (existsSync(file)) return true;
		out(`skipped ${label}: not found on this machine`);
		return false;
	};
	if (present("claude-history", claudeHistory)) sources.push(claudeHistorySource({ files: realFiles, path: claudeHistory }));
	if (present("omp-history", path.join(omp, "history.db"))) {
		const history = readOnlyDb(path.join(omp, "history.db"), closers);
		sources.push(ompHistorySource(history), ompRecapSource(history));
	}
	if (present("omp-memory", path.join(omp, "agent.db"))) {
		sources.push(ompMemorySource({ agentDb: readOnlyDb(path.join(omp, "agent.db"), closers), files: realFiles, memoriesDir: path.join(omp, "memories") }));
	}
	const signet = path.join(home, ".agents", "data", "signet.db");
	if (present("signet-summary", signet)) sources.push(signetSummarySource({ db: readOnlyDb(signet, closers), minMentions }));
	return { sources, close: () => closers.forEach((close) => close()) };
}

/** Existing structured-output path: the app's own submit-agent (one TypeBox tool call), on the extractor role's configured model. */
async function realLlm(): Promise<LlmPort> {
	const { stores } = await import("../src/server/stores.ts");
	const { resolveRoleSpec } = await import("../src/core/settings-resolution.ts");
	const { piEngineForSpec } = await import("../src/agent/models.ts");
	const { runSubmitAgent } = await import("../src/agent/subagents/submit-agent.ts");
	const spec = resolveRoleSpec("extractor", stores.settingsStore.readSettings());
	if (!spec) throw new LlmUnavailableError("no model is configured for the extractor role: set a model slot in Settings, then rerun");
	const engine = piEngineForSpec(spec);
	return {
		complete: <S extends TSchema>(prompt: string, schema: S) =>
			runSubmitAgent<Static<S>>({
				role: "extractor",
				toolName: "submit",
				toolDescription: "Submit the answer in the requested structure.",
				parameters: schema,
				fill: (input) => input,
				systemPrompt: "Answer by calling submit exactly once with the requested structure.",
				prompt,
				engine,
				signal: undefined,
				onStep: () => {},
				neverSubmitted: "the model never submitted an answer",
			}),
	};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error(error instanceof Error ? error.message : "seed failed");
			process.exitCode = 1;
		},
	);
}
