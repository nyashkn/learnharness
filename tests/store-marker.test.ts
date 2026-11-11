/**
 * P3 (lh-bzn): the storage.json marker, the first-write rule, per-instance factories, the store lock.
 * Folders are temp dirs; every expectation comes from an oracle written here, never from the code under test.
 */
import assert from "node:assert/strict";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { after, describe, it, mock } from "node:test";

/** doltlite has an adapter on darwin-arm64 and linux-x64 only (marker.adapterFor); a hardcoded literal, not derived from src. */
const DOLTLITE_HOST = ["darwin-arm64", "linux-x64"].includes(`${process.platform}-${process.arch}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-marker-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
// The singletons (config-built) live in their own throwaway folder, never the repo's data/.
process.env.HOME = path.join(root, "home"); // the machine id file goes here, never to the real ~/.learnharness
process.env.LH_DATA_DIR = path.join(root, "singleton-data");
process.env.LH_AUTH_FILE = path.join(root, "singleton-auth.json");
delete process.env.LH_STORAGE;

const marker = await import("../src/store/marker.ts");
const { createFileStores, runStoreScript } = await import("../src/store/file-stores.ts");
const { acquireStoreLock, StoreLockedError } = await import("../src/store/sql/lock.ts");
const { machineId } = await import("../src/store/sql/machine-id.ts");
const { createGraphStore, graphPaths } = await import("../src/store/graph.ts");
const { StorageVersionError } = await import("../src/store/graph-format.ts");
const { CURRENT_GRAPH_FORMAT_VERSION } = await import("../src/core/contracts/graph.ts");

let n = 0;
const fresh = (): string => path.join(root, `d${n++}`);
const auth = (dir: string): string => path.join(root, `auth-${path.basename(dir)}.json`); // outside the data folder, like production
const NODE = (id: string) => ({ id, name: id, statement: id, aliases: [], createdAt: "t", provenance: [] });

/** path -> bytes for everything under dir ("" if the folder is absent): an independent snapshot. */
function snapshot(dir: string): string {
	if (!fs.existsSync(dir)) return "ABSENT";
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of fs.readdirSync(d).sort()) {
			const p = path.join(d, name);
			if (fs.statSync(p).isDirectory()) { out.push(`${path.relative(dir, p)}/`); walk(p); }
			else out.push(`${path.relative(dir, p)}=${fs.readFileSync(p, "utf8")}`);
		}
	};
	walk(dir);
	return out.join("\n");
}

// ─── 1. marker resolution: the truth table ──────────────────────────────────

type MarkerState =
	| { kind: "absent" }
	| { kind: "text"; text: string };
type Folder = "no-folder" | "empty" | "leftover-jsonl" | "chat-file";
type Outcome = "file" | "sqlite" | "version" | "corrupt" | "no-adapter" | "doltlite";

const BAD_MARKERS: { text: string; outcome: Outcome }[] = [
	{ text: "{not json", outcome: "corrupt" },
	{ text: "[]", outcome: "corrupt" },
	{ text: "null", outcome: "corrupt" },
	{ text: "", outcome: "corrupt" },
	{ text: '{"backend":"file"}', outcome: "corrupt" }, // layout missing
	{ text: '{"backend":"file","layout":0}', outcome: "corrupt" },
	{ text: '{"backend":"file","layout":-3}', outcome: "corrupt" },
	{ text: '{"backend":"file","layout":1.5}', outcome: "corrupt" },
	{ text: '{"backend":"file","layout":"1"}', outcome: "corrupt" },
	{ text: '{"backend":"file","layout":null}', outcome: "corrupt" },
	{ text: '{"layout":1}', outcome: "corrupt" }, // backend missing
	{ text: '{"backend":"mysql","layout":1}', outcome: "corrupt" },
	{ text: '{"backend":7,"layout":1}', outcome: "corrupt" },
	{ text: '{"backend":"file","layout":2}', outcome: "version" },
	{ text: '{"backend":"file","layout":99}', outcome: "version" },
	{ text: '{"backend":"mysql","layout":2}', outcome: "version" }, // a newer build may know the backend: version wins
	{ text: '{"backend":"file","layout":1}', outcome: "file" },
	{ text: '{"backend":"sqlite","layout":1}', outcome: "corrupt" }, // agreement: the marker names graph.sqlite, which the table never builds
	{ text: '{"backend":"doltlite","layout":1}', outcome: DOLTLITE_HOST ? "corrupt" : "no-adapter" }, // a DoltLite host: an adapter exists, so the missing graph.doltlite is the agreement refusal
];
const ENVS = [undefined, "", "file", "sqlite", "doltlite", "bogus"] as const;

/** The spec as a decision table (ADR 0004, 0009, architecture §3), written independently of marker.ts. */
function oracle(m: MarkerState, folder: Folder, env: string | undefined): Outcome {
	if (m.kind === "text") return BAD_MARKERS.find((b) => b.text === m.text)!.outcome;
	const empty = folder === "no-folder" || folder === "empty";
	if (!empty || env === undefined || env === "") return "file"; // missing marker = file; LH_STORAGE ignored on a non-empty folder
	if (env === "file") return "file";
	if (env === "sqlite") return "sqlite"; // an intent only: the store is made on the first write
	if (env === "doltlite") return DOLTLITE_HOST ? "doltlite" : "no-adapter"; // an intent only, like sqlite
	return "corrupt"; // an unknown LH_STORAGE on an empty folder
}

function build(dir: string, m: MarkerState, folder: Folder): void {
	if (folder === "no-folder" && m.kind === "absent") return;
	fs.mkdirSync(dir, { recursive: true });
	if (folder === "leftover-jsonl") { fs.mkdirSync(path.join(dir, "graph")); fs.writeFileSync(path.join(dir, "graph", "nodes.jsonl"), `${JSON.stringify(NODE("a"))}\n`); }
	if (folder === "chat-file") { fs.mkdirSync(path.join(dir, "chats")); fs.writeFileSync(path.join(dir, "chats", "chat_x.json"), "{}"); }
	if (m.kind === "text") fs.writeFileSync(path.join(dir, "storage.json"), m.text);
}

function outcomeOf(fn: () => unknown): Outcome {
	try { const v = fn(); return v === "sqlite" ? "sqlite" : v === "doltlite" ? "doltlite" : "file"; } catch (e) {
		if (e instanceof StorageVersionError) return "version";
		const name = (e as Error).name;
		if (name === "StorageMarkerError") return "corrupt";
		if (name === "NoAdapterError") return "no-adapter";
		throw e;
	}
}

describe("marker resolution (open)", () => {
	const markerArb: fc.Arbitrary<MarkerState> = fc.oneof(
		fc.constant<MarkerState>({ kind: "absent" }),
		fc.constantFrom(...BAD_MARKERS).map((b): MarkerState => ({ kind: "text", text: b.text })),
	);
	const folderArb = fc.constantFrom<Folder>("no-folder", "empty", "leftover-jsonl", "chat-file");
	const envArb = fc.constantFrom(...ENVS);

	it("open refuses or accepts exactly as the decision table says, and never writes", () => {
		fc.assert(fc.property(markerArb, folderArb, envArb, (m, folder, env) => {
			const dir = fresh();
			build(dir, m, folder);
			const before = snapshot(dir);
			const got = outcomeOf(() => marker.openDataFolder(dir, { LH_STORAGE: env }));
			assert.equal(got, oracle(m, folder, env), `${JSON.stringify({ m, folder, env })}`);
			assert.equal(snapshot(dir), before, "open must not create, change or delete anything");
		}), {
			numRuns: 300,
			// Regression seeds: the cells that matter most, run every time.
			examples: [
				[{ kind: "absent" }, "leftover-jsonl", "sqlite"], // LH_STORAGE on a non-empty folder: ignored, not a conflict
				[{ kind: "absent" }, "chat-file", "bogus"], // even a bogus value is ignored there
				[{ kind: "absent" }, "empty", "sqlite"], // honoured on an empty folder -> the sqlite backend (nothing written at open)
				[{ kind: "absent" }, "empty", "doltlite"], // honoured on an empty folder -> doltlite on a DoltLite host, no adapter elsewhere
				[{ kind: "absent" }, "no-folder", "file"],
				[{ kind: "text", text: '{"backend":"file","layout":2}' }, "leftover-jsonl", undefined],
				[{ kind: "text", text: "{not json" }, "leftover-jsonl", undefined], // a corrupt marker is never "missing"
			],
		});
	});

	it("the unsupported-layout refusal is a StorageVersionError naming the marker file, found and supported", () => {
		const dir = fresh();
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "storage.json"), '{"backend":"file","layout":7}');
		assert.throws(() => marker.openDataFolder(dir, {}), (e: unknown) => e instanceof StorageVersionError && e.file === path.join(dir, "storage.json") && e.found === 7 && e.supported === 1 && e.name === "StorageVersionError");
	});

	it("a graph format stamped newer refuses at open even with no marker (file backend: valid = not stamped newer)", () => {
		const dir = fresh();
		fs.mkdirSync(path.join(dir, "graph"), { recursive: true });
		fs.writeFileSync(path.join(dir, "graph", "format.json"), JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION + 1 }));
		assert.throws(() => marker.openDataFolder(dir, {}), StorageVersionError);
		assert.throws(() => createFileStores(dir, auth(dir)), StorageVersionError);
	});

	it("a marker that goes newer AFTER open still refuses the next write, and the write leaves nothing", () => {
		const dir = fresh();
		const s = createFileStores(dir, auth(dir));
		s.settingsStore.writeSettings({ version: 1 });
		fs.writeFileSync(path.join(dir, "storage.json"), '{"backend":"file","layout":2}');
		const before = snapshot(dir);
		assert.throws(() => s.chatStore.createChat("x"), StorageVersionError);
		assert.throws(() => s.graphStore.appendNode(NODE("a")), StorageVersionError);
		assert.equal(snapshot(dir), before);
		marker.releaseStoreLock(dir);
	});
});

// ─── 2. reads never write ───────────────────────────────────────────────────

describe("no file appears on open or read", () => {
	it("every read of every store leaves a fresh folder (absent or empty) byte-identical", () => {
		const reads: Record<string, (s: ReturnType<typeof createFileStores>) => unknown> = {
			listChats: (s) => s.chatStore.listChats(), getChat: (s) => s.chatStore.getChat("chat_a"),
			listJobs: (s) => s.jobStore.listJobs("chat_a"), getJob: (s) => s.jobStore.getJob("job_a"),
			readSettings: (s) => s.settingsStore.readSettings(), readFileAccessSettings: (s) => s.settingsStore.readFileAccessSettings(),
			listOverrides: (s) => s.promptOverrides.listOverrides(), readOverride: (s) => s.promptOverrides.readOverride("system-prompt.md"),
			readNodes: (s) => s.graphStore.readNodes(), readChains: (s) => s.graphStore.readChains(), readCheckpoints: (s) => s.graphStore.readCheckpoints(),
			readCoverage: (s) => s.graphStore.readCoverage(), readSources: (s) => s.graphStore.readSources(), readPositions: (s) => s.graphStore.readPositions(),
			revision: (s) => s.graphStore.revision?.(), sourceOrgRead: (s) => s.sourceOrganizationStore.read(), renderRead: (s) => s.renderSettingsStore.readRenderSettings(),
			authVars: (s) => s.authStore.authVars(),
		};
		fc.assert(fc.property(fc.constantFrom("no-folder", "empty"), fc.array(fc.constantFrom(...Object.keys(reads)), { minLength: 1, maxLength: 12 }), (kind, seq) => {
			const dir = fresh();
			if (kind === "empty") fs.mkdirSync(dir);
			const before = snapshot(dir);
			const s = createFileStores(dir, auth(dir));
			for (const r of seq) reads[r]!(s);
			assert.equal(snapshot(dir), before, seq.join(","));
			assert.equal(fs.existsSync(auth(dir)), false);
		}), { numRuns: 60, examples: [["no-folder", ["listChats"]], ["no-folder", ["listJobs"]]] }); // listChats/listJobs used to mkdir on read
	});
});

// ─── 3. marker + lock on the first write of each family ─────────────────────

type S = ReturnType<typeof createFileStores>;
const FAMILIES: Record<string, (s: S) => unknown> = {
	chats: (s) => s.chatStore.createChat("hello"),
	jobs: (s) => s.jobStore.createJob({ kind: "research", chatId: "chat_a", toolCallId: "t1" } as never),
	settings: (s) => s.settingsStore.writeSettings({ version: 1 } as never),
	prompts: (s) => s.promptOverrides.writeOverride("system-prompt.md", "x"),
	graphLedger: (s) => s.graphStore.appendNode(NODE("a")),
	graphSources: (s) => s.graphStore.upsertSource({ id: "src_1", filePath: "/x", importedAt: "t" } as never),
	graphPositions: (s) => s.graphStore.writePositions({ a: { x: 1, y: 2 } }),
	graphRewrite: (s) => s.graphStore.rewriteLedgers({ nodes: [NODE("a")] }),
	renderSettings: (s) => s.renderSettingsStore.writeRenderSettings({}),
	sourceOrganization: (s) => s.sourceOrganizationStore.write(s.sourceOrganizationStore.read()),
	transactAppend: (s) => s.graphStore.transact("t", () => s.graphStore.appendNode(NODE("a"))),
};

describe("marker and lock are written on the first write, not before", () => {
	for (const [family, write] of Object.entries(FAMILIES)) {
		it(`${family}: nothing at open or read; marker + lock after the write`, () => {
			const dir = fresh();
			const s = createFileStores(dir, auth(dir));
			s.chatStore.listChats(); s.graphStore.readNodes();
			assert.equal(fs.existsSync(path.join(dir, "storage.json")), false);
			assert.equal(fs.existsSync(path.join(dir, "storage.json.lock")), false);
			write(s);
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "storage.json"), "utf8")), { backend: "file", layout: 1 });
			const lock = JSON.parse(fs.readFileSync(path.join(dir, "storage.json.lock"), "utf8"));
			assert.equal(lock.pid, process.pid);
			assert.equal(fs.readdirSync(dir).some((f) => f.includes(".tmp")), false, "marker written atomically, no temp left");
			marker.releaseStoreLock(dir);
		});
	}

	it("auth.json is outside the data folder: writing a key triggers neither marker nor lock", () => {
		const dir = fresh();
		const s = createFileStores(dir, auth(dir));
		s.authStore.setAuthVar("SOME_KEY", "v");
		assert.equal(fs.existsSync(dir), false);
		assert.equal(fs.existsSync(auth(dir)), true);
	});

	it("a transact that throws writes nothing: no marker, no lock", () => {
		const dir = fresh();
		const s = createFileStores(dir, auth(dir));
		assert.throws(() => s.graphStore.transact("t", () => { s.graphStore.appendNode(NODE("a")); throw new Error("boom"); }), /boom/);
		assert.equal(fs.existsSync(dir), false);
	});

	it("an LH_STORAGE=file choice on an empty folder is written into the marker on first write", () => {
		const dir = fresh();
		fs.mkdirSync(dir);
		const old = process.env.LH_STORAGE;
		process.env.LH_STORAGE = "file";
		try { marker.beforeWrite(dir); } finally { if (old === undefined) delete process.env.LH_STORAGE; else process.env.LH_STORAGE = old; }
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "storage.json"), "utf8")), { backend: "file", layout: 1 });
		marker.releaseStoreLock(dir);
	});

	it("LH_STORAGE is honoured at the first write: a refused choice leaves no marker and no lock (lh-uwy)", () => {
		const cases: [string, "no-adapter" | "corrupt"][] = [...(DOLTLITE_HOST ? [] : [["doltlite", "no-adapter"] as [string, "no-adapter"]]), ["bogus", "corrupt"]]; // doltlite has an adapter on a DoltLite host (tests/doltlite-backend.test.ts)
		for (const [value, outcome] of cases) {
			const dir = fresh();
			fs.mkdirSync(dir);
			const old = process.env.LH_STORAGE;
			process.env.LH_STORAGE = value;
			try {
				assert.throws(() => marker.beforeWrite(dir), (e) => outcome === "no-adapter" ? e instanceof marker.NoAdapterError : e instanceof marker.StorageMarkerError, value);
			} finally { if (old === undefined) delete process.env.LH_STORAGE; else process.env.LH_STORAGE = old; }
			assert.deepEqual(fs.readdirSync(dir), [], `${value}: the folder is still empty`);
			assert.equal(marker.holdsStoreLock(dir), false);
		}
	});

	it("an existing marker is never rewritten by a write", () => {
		const dir = fresh();
		fs.mkdirSync(dir);
		const text = '{"backend":"file","layout":1,"note":"keep"}';
		fs.writeFileSync(path.join(dir, "storage.json"), text);
		createFileStores(dir, auth(dir)).chatStore.createChat("x");
		assert.equal(fs.readFileSync(path.join(dir, "storage.json"), "utf8"), text);
		marker.releaseStoreLock(dir);
	});
});

// ─── 4. two factories, two folders: no cross-talk (including transact) ──────

describe("factories are per instance", () => {
	type Op = { dir: 0 | 1; kind: "append" | "commit" | "throw" | "commitWritingOther"; id: number };
	it("a model of two folders agrees with the stores after any op sequence (transact state is per instance)", () => {
		const opArb = fc.record({ dir: fc.constantFrom<0 | 1>(0, 1), kind: fc.constantFrom<Op["kind"]>("append", "commit", "throw", "commitWritingOther"), id: fc.nat(50) });
		fc.assert(fc.property(fc.array(opArb, { maxLength: 14 }), (ops) => {
			const dirs = [fresh(), fresh()] as const;
			const g = [createGraphStore(path.join(dirs[0], "graph")), createGraphStore(path.join(dirs[1], "graph"))] as const;
			const model: string[][] = [[], []];
			ops.forEach((op, i) => {
				const mine = g[op.dir], other = g[1 - op.dir as 0 | 1], id = `n${i}_${op.id}`, oid = `o${i}_${op.id}`;
				if (op.kind === "append") { mine.appendNode(NODE(id)); model[op.dir]!.push(id); }
				else if (op.kind === "commit") { mine.transact("c", () => { mine.appendNode(NODE(id)); mine.transact("nested", () => mine.appendNode(NODE(`${id}b`))); }); model[op.dir]!.push(id, `${id}b`); }
				else if (op.kind === "throw") { assert.throws(() => mine.transact("t", () => { mine.appendNode(NODE(id)); throw new Error("boom"); })); }
				else {
					// While `mine` has a transaction open, a write to the OTHER folder lands at once and is invisible to mine.
					mine.transact("x", () => {
						mine.appendNode(NODE(id));
						other.appendNode(NODE(oid));
						assert.deepEqual(other.readNodes().map((x) => x.id), [...model[1 - op.dir]!, oid], "the other folder's write is immediate, not buffered in mine's log");
						assert.equal(mine.readNodes().some((x) => x.id === oid), false, "and mine does not see it");
					});
					model[op.dir]!.push(id); model[1 - op.dir]!.push(oid);
				}
				for (const k of [0, 1] as const) assert.deepEqual(g[k].readNodes().map((x) => x.id), model[k], `folder ${k} after op ${i} ${JSON.stringify(op)}`);
			});
			for (const d of dirs) marker.releaseStoreLock(d);
		}), { numRuns: 40, examples: [[[{ dir: 0, kind: "commitWritingOther", id: 0 }]]] });
	});

	it("source-organization joins ITS graph store's transact (rolls back with it) and is untouched by another store's", () => {
		const a = createFileStores(fresh(), "/dev/null"), b = createFileStores(fresh(), "/dev/null");
		const folder = { version: 1, folders: [{ id: "f1", name: "f1", parentId: null, createdAt: "t" }], placements: {} } as never;
		const empty = JSON.stringify(a.sourceOrganizationStore.read());
		assert.throws(() => a.graphStore.transact("t", () => { a.sourceOrganizationStore.write(folder); throw new Error("boom"); }), /boom/);
		assert.equal(JSON.stringify(a.sourceOrganizationStore.read()), empty, "rolled back with its own graph store");
		// B's open transaction must not swallow A's write (a shared module-level log would defer it into B's rollback).
		assert.throws(() => b.graphStore.transact("t", () => { a.sourceOrganizationStore.write(folder); throw new Error("boom"); }), /boom/);
		assert.equal(a.sourceOrganizationStore.read().folders.length, 1, "A's write landed immediately");
	});
});

// ─── 5. the lock ────────────────────────────────────────────────────────────

describe("the store lock", () => {
	it("a write while another host holds the lock is refused, naming the holder; nothing is written", () => {
		const dir = fresh();
		fs.mkdirSync(dir);
		acquireStoreLock(path.join(dir, "storage.json"), { pid: 4242, host: "other-machine" });
		const s = createFileStores(dir, auth(dir));
		const before = snapshot(dir);
		assert.throws(() => s.chatStore.createChat("x"), (e: unknown) => e instanceof StoreLockedError && e.holder?.pid === 4242 && /pid 4242 on other-machine/.test(e.message));
		assert.equal(snapshot(dir), before);
		assert.equal(s.chatStore.listChats().length, 0, "reads still work while another process holds the lock");
	});

	// Delete paths are writes too (lh-7km): each must take the lock before removing anything.
	const DELETES: Record<string, { seed: (s: S) => unknown; del: (s: S, seeded: unknown) => unknown }> = {
		deleteChat: { seed: (s) => s.chatStore.createChat("hello"), del: (s, c) => s.chatStore.deleteChat((c as { id: string }).id) },
		deleteJobsForChat: { seed: (s) => s.jobStore.createJob({ kind: "research", chatId: "chat_a", toolCallId: "t1" } as never), del: (s) => s.jobStore.deleteJobsForChat("chat_a") },
		deleteOverride: { seed: (s) => s.promptOverrides.writeOverride("system-prompt.md", "x"), del: (s) => s.promptOverrides.deleteOverride("system-prompt.md") },
		deleteSourceMap: { seed: (s) => s.graphStore.upsertSource({ id: "src_1", filePath: "/x", importedAt: "t" } as never), del: (s) => s.graphStore.deleteSources(new Set(["src_1"])) },
	};
	for (const [name, { seed, del }] of Object.entries(DELETES)) {
		it(`${name}: refused while another host holds the lock; nothing is removed`, () => {
			const dir = fresh();
			const s = createFileStores(dir, auth(dir));
			const seeded = seed(s);
			marker.releaseStoreLock(dir); // our lock goes away; another machine now holds the store
			acquireStoreLock(path.join(dir, "storage.json"), { pid: 4242, host: "other-machine" });
			const before = snapshot(dir);
			assert.throws(() => del(s, seeded), (e: unknown) => e instanceof StoreLockedError && e.holder?.pid === 4242, name);
			assert.equal(snapshot(dir), before);
		});
	}

	it("scripts take the lock: refused while a live holder has it (holder named), run and release when it is stale", async () => {
		const dir = fresh();
		fs.mkdirSync(dir);
		const file = path.join(dir, "storage.json");
		acquireStoreLock(file, { pid: 999991, host: machineId() });
		const errors: string[] = [];
		const spy = mock.method(console, "error", (...a: unknown[]) => { errors.push(a.join(" ")); });
		let ran = false;
		try {
			await runStoreScript(dir, auth(dir), () => { ran = true; }, { isAlive: () => true });
			assert.equal(ran, false, "main must not run");
			assert.equal(process.exitCode, 1);
			assert.match(errors.join("\n"), /pid 999991/);
			process.exitCode = 0;
			// the holder died: reclaimed, the script runs, holds the lock while running, releases after
			let during = false;
			await runStoreScript(dir, auth(dir), (s) => { during = JSON.parse(fs.readFileSync(`${file}.lock`, "utf8")).pid === process.pid; s.settingsStore.writeSettings({ version: 1 } as never); }, { isAlive: () => false });
			assert.equal(during, true, "the script holds the lock while it runs");
			assert.equal(fs.existsSync(`${file}.lock`), false, "released in finally");
			// and released when main throws
			await assert.rejects(runStoreScript(dir, auth(dir), () => { throw new Error("script bug"); }), /script bug/);
			assert.equal(fs.existsSync(`${file}.lock`), false);
		} finally {
			spy.mock.restore();
			process.exitCode = 0;
		}
	});

	it("a script refuses a newer folder before touching it", async () => {
		const dir = fresh();
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "storage.json"), '{"backend":"file","layout":3}');
		const spy = mock.method(console, "error", () => {});
		let ran = false;
		try {
			await runStoreScript(dir, auth(dir), () => { ran = true; });
			assert.equal(ran, false);
			assert.equal(process.exitCode, 1);
		} finally { spy.mock.restore(); process.exitCode = 0; }
		assert.equal(fs.existsSync(path.join(dir, "storage.json.lock")), false);
	});

	it("the same process never refuses itself: two store sets on one folder, and a second module instance", async () => {
		const dir = fresh();
		const a = createFileStores(dir, auth(dir)), b = createFileStores(dir, auth(dir));
		a.chatStore.createChat("a");
		b.chatStore.createChat("b");
		const second = await import(`../src/store/marker.ts?second-instance-${n++}`) as typeof marker;
		assert.notEqual(second.beforeWrite, marker.beforeWrite, "really a second module instance");
		second.beforeWrite(dir);
		assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".lock")).length, 1);
		marker.releaseStoreLock(dir);
	});

	it("if the lock file disappears (a test removed the folder) the next write re-acquires it", () => {
		const dir = fresh();
		const s = createFileStores(dir, auth(dir));
		s.chatStore.createChat("a");
		fs.rmSync(dir, { recursive: true });
		s.chatStore.createChat("b");
		assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "storage.json.lock"), "utf8")).pid, process.pid);
		assert.equal(marker.holdsStoreLock(dir), true);
		marker.releaseStoreLock(dir);
	});
});

// ─── 6. the wiring ──────────────────────────────────────────────────────────

describe("the old exports ARE the factory instances, and stores.ts wires those", () => {
	it("stores.ts holds the very objects the store modules export (one instance per folder)", async () => {
		const { stores } = await import("../src/server/stores.ts");
		const [chats, graph, jobs, settings, authM, prompts, render, sourceOrg] = await Promise.all([
			import("../src/store/chats.ts"), import("../src/store/graph.ts"), import("../src/store/jobs.ts"), import("../src/store/settings.ts"),
			import("../src/store/auth.ts"), import("../src/store/prompt-overrides.ts"), import("../src/store/render-settings.ts"), import("../src/store/source-organization.ts"),
		]);
		assert.equal(stores.chatStore, chats.chatStore);
		assert.equal(stores.graphStore, graph.graphStore);
		assert.equal(stores.jobStore, jobs.jobStore);
		assert.equal(stores.settingsStore, settings.settingsStore);
		assert.equal(stores.authStore, authM.authStore);
		assert.equal(stores.promptOverrides, prompts.promptOverrides);
		assert.equal(stores.renderSettingsStore, render.renderSettingsStore);
		assert.equal(stores.sourceOrganizationStore, sourceOrg.sourceOrganizationStore);
	});

	it("graphPaths(PATHS.graph) names exactly the files config.ts publishes", async () => {
		const cfg = await import("../config.ts");
		const p = graphPaths(cfg.PATHS.graph);
		assert.deepEqual({ nodes: p.nodes, chains: p.chains, sessions: p.sessions, coverage: p.coverage }, { ...cfg.LEDGER_FILES });
		assert.equal(p.sources, cfg.SOURCES_FILE);
		assert.equal(p.positions, cfg.POSITIONS_FILE);
		assert.equal(p.format, cfg.GRAPH_FORMAT_FILE);
		assert.equal(path.join(cfg.PATHS.graph, "source-organization.json"), cfg.SOURCE_ORGANIZATION_FILE);
		assert.equal(path.join(cfg.PATHS.graph, "render-settings.json"), cfg.RENDER_SETTINGS_FILE);
		assert.equal(path.join(cfg.PATHS.data, "settings.json"), cfg.SETTINGS_FILE);
	});
});

// ─── 7. boot registration of the custom endpoint ────────────────────────────

describe("boot", () => {
	it("importing the keys module syncs the custom endpoint (settings.json is read at import, before any piModels() call)", () => {
		const home = fs.mkdtempSync(path.join(root, "boot-"));
		fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ version: 1, customProvider: { baseUrl: "http://boot.invalid/v1", authMode: "keyless", models: [{ id: "m" }] } }));
		const code = `
			import fs from "node:fs";
			import { syncBuiltinESMExports } from "node:module";
			const read = fs.readFileSync;
			let settingsReads = 0;
			fs.readFileSync = (...a) => { if (String(a[0]).endsWith("settings.json")) settingsReads++; return read(...a); };
			syncBuiltinESMExports();
			await import(${JSON.stringify(path.resolve(import.meta.dirname, "../src/server/keys.ts"))});
			console.log(JSON.stringify({ settingsReads }));`;
		const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
			cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30000,
			env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "test", LH_DATA_DIR: home, LH_AUTH_FILE: path.join(home, "auth.json") },
		});
		assert.equal(r.status, 0, r.stderr);
		const { settingsReads } = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { settingsReads: number };
		assert.ok(settingsReads > 0, "the boot sync must read the settings record when keys.ts loads");
	});
});

// ─── 5. the server releases its lock on exit, SIGTERM and SIGINT (lh-bzc) ───

describe("lock release on shutdown", () => {
	const markerTs = path.resolve(import.meta.dirname, "../src/store/marker.ts");
	const run = (dir: string, how: "exit" | "SIGTERM" | "SIGINT" | "SIGTERM-with-listener") =>
		new Promise<{ code: number | null; signal: NodeJS.Signals | null; lockAtReady: boolean }>((resolve, reject) => {
			const home = fresh();
			fs.mkdirSync(home);
			const code = `
				import { beforeWrite } from ${JSON.stringify(markerTs)};
				${how === "SIGTERM-with-listener" ? 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 50));' : ""}
				beforeWrite(${JSON.stringify(dir)});
				console.log("ready");
				${how === "exit" ? "process.stdin.resume(); // stdin keeps the child alive until the parent ends it; then it exits 0 by itself" : "setInterval(() => {}, 1000);"}`;
			const c = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
				cwd: path.resolve(import.meta.dirname, ".."), env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "test" },
			});
			let err = "", ready = false;
			c.stderr.on("data", (d) => (err += d));
			c.stdout.on("data", () => {
				if (ready) return;
				ready = true;
				const lockAtReady = fs.existsSync(path.join(dir, "storage.json.lock"));
				if (how === "exit") c.stdin.end(); // EOF lets the child exit on its own, after the check above
				else c.kill(how === "SIGINT" ? "SIGINT" : "SIGTERM");
				const killer = setTimeout(() => c.kill("SIGKILL"), 5000); // a child that swallows the signal fails the test, not hangs it
				c.on("exit", () => clearTimeout(killer));
				c.on("exit", (code, signal) => resolve({ code, signal, lockAtReady }));
			});
			c.on("error", reject);
			c.on("exit", () => { if (!ready) reject(new Error(err)); });
		});

	for (const how of ["exit", "SIGTERM", "SIGINT"] as const) {
		it(`${how}: the lock is gone afterwards${how === "exit" ? "" : " and the child still dies by that signal"}`, async () => {
			const dir = fresh();
			const r = await run(dir, how);
			assert.equal(r.lockAtReady, true, "the child held the lock before the shutdown");
			assert.equal(fs.existsSync(path.join(dir, "storage.json.lock")), false);
			if (how === "exit") assert.deepEqual([r.code, r.signal], [0, null]);
			else assert.deepEqual([r.code, r.signal], [null, how]);
		});
	}

	it("SIGTERM with another listener: the lock is released and the exit is left to that listener", async () => {
		const dir = fresh();
		const r = await run(dir, "SIGTERM-with-listener");
		assert.equal(fs.existsSync(path.join(dir, "storage.json.lock")), false);
		assert.deepEqual([r.code, r.signal], [0, null]);
	});
});
