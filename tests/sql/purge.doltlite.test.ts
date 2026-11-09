/**
 * D4 purge history (bead lh-5n3). After delete source + purge, the deleted text is absent from dolt_log,
 * dolt_at_*, dolt_history_* and the raw bytes of the file. Every scan runs BEFORE purge too (the negative control).
 * Expected values come from a model written here, never from the code under test.
 *
 *   P1 real path   P2 live rows   P3 readers   P4 backup   P5 refusals   P6 crash / repeat / root-only   P7 model
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import fc from "fast-check";
import { runCli } from "../../scripts/lh-storage";
import type { GraphNode, NotesSource } from "../../src/core/contracts";
import { deleteSourcesTraces } from "../../src/core/graph-deletion";
import type { SqlDriver } from "../../src/store/sql/driver";
import { openDoltlite, openReaderAt, RECOVER_MESSAGE } from "../../src/store/sql/drivers/doltlite";
import { faultyDriver, InjectedFault } from "../../src/store/sql/drivers/faulty";
import { openGraphStore, type OpenedGraph } from "../../src/store/sql/graph-store";
import { acquireStoreLock, lockFileFor, type StoreLock } from "../../src/store/sql/lock";
import { PURGE_TEXT, PurgeRefusedError, purgeHistory } from "../../src/store/sql/purge";

let dir: string;
let n = 0;
before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-purge-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const TABLES = ["ledger_nodes", "ledger_chains", "ledger_coverage", "ledger_checkpoints", "sources", "documents", "lh_meta"];
const lockOf = (file: string): StoreLock => ({ lockFile: lockFileFor(file), release() {} });
const marker = (tag = "M") => `${tag}-${randomUUID()}`; // runtime: this file never contains a searchable literal
const node = (id: string, statement: string, source: string): GraphNode => ({ id, name: id, statement, aliases: [], createdAt: "t", provenance: [{ chatId: source, messageId: "m1" }] });
const notes = (id: string): NotesSource => ({ id, filePath: `/x/${id}`, importedAt: "t" });
const positions = () => ({ read: () => ({}), write: () => {} });

interface Rig {
	file: string;
	db: SqlDriver;
	opened: OpenedGraph;
	graph: OpenedGraph["store"];
}
/** A migrated real store on openDoltlite with the real SQL GraphStore. */
function rig(file = path.join(dir, `s${n++}.doltlite`)): Rig {
	const db = openDoltlite(file, { lock: lockOf(file) });
	const opened = openGraphStore({ db, file, lhVersion: "test", positions: positions(), log: () => {} });
	return { file, db, opened, graph: opened.store };
}
/** The real source-deletion path: source-deletion.ts runs exactly these two calls. */
function deleteSource(r: Rig, id: string): void {
	r.graph.transact(`delete sources:1`, () => {
		deleteSourcesTraces(r.graph, new Set([id]), "delete-nodes");
		r.graph.deleteSources(new Set([id]));
	});
}
const logHashes = (db: SqlDriver) => db.all<{ commit_hash: string }>("SELECT commit_hash FROM dolt_log").map((r) => r.commit_hash);
const logCount = (db: SqlDriver) => logHashes(db).length;
const nodeIds = (r: Rig) => r.graph.readNodes().map((x) => x.id);
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const backups = (file: string) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file, path.extname(file))}.bak-purge-`));

/** Everything that can hold the text. `hashes` = commits that existed before the purge. */
function scan(db: SqlDriver, file: string, needle: string, hashes: string[]) {
	const hit = (rows: unknown) => JSON.stringify(rows).includes(needle);
	const log = hit(db.all("SELECT * FROM dolt_log"));
	let history = false;
	for (const t of TABLES) history ||= hit(db.all(`SELECT * FROM dolt_history_${t}`));
	let at = false;
	let refused = 0;
	for (const h of hashes)
		for (const t of TABLES) {
			try {
				at ||= hit(db.all(`SELECT * FROM dolt_at_${t}('${h}')`));
			} catch {
				refused++;
			}
		}
	const base = path.basename(file);
	const siblings = fs.readdirSync(path.dirname(file)).filter((f) => f === base || f.startsWith(`${base}-`)); // the backup is `<stem>.bak-purge-*`, never matched
	const bytes = siblings.some((f) => fs.readFileSync(path.join(path.dirname(file), f)).includes(Buffer.from(needle)));
	return { log, history, at, refused, bytes };
}

describe("P1 real path: delete a source, purge, the text is gone", () => {
	test("negative control finds the text before; nowhere after; old hashes refuse", () => {
		const r = rig();
		const keep = marker("KEEP");
		const gone = marker("GONE");
		r.graph.upsertSource(notes("keep"));
		r.graph.upsertSource(notes("doomed"));
		r.graph.appendNode(node("k", keep, "keep"));
		r.graph.appendNode(node("d", gone, "doomed"));
		deleteSource(r, "doomed");
		assert.deepEqual(nodeIds(r), ["k"], "real deletion removed the statement line itself");
		const hashes = logHashes(r.db);

		const before = scan(r.db, r.file, gone, hashes);
		assert.ok(before.history || before.at, "control: found in dolt_history_* or dolt_at_*");
		assert.ok(before.bytes, "control: found in the raw bytes");
		console.log(`FACT purge control before: history=${before.history} at=${before.at} bytes=${before.bytes}`);

		const res = purgeHistory(r.db, r.file);
		const after = scan(r.db, r.file, gone, hashes);
		assert.deepEqual({ log: after.log, history: after.history, at: after.at, bytes: after.bytes }, { log: false, history: false, at: false, bytes: false });
		assert.ok(after.refused > 0, "pre-purge hashes no longer resolve");
		// the kept statement is still stored and was found by the same scan
		assert.ok(scan(r.db, r.file, keep, []).bytes, "control: a live marker is still in the bytes");
		console.log(`FACT purge real result: ${res.commitsBefore} commits -> ${res.commitsAfter}, gc="${res.gc}"`);
		r.db.close();
	});
});

describe("P2 live rows survive", () => {
	test("same rows in the same order after purge and after reopen; still writes and seals", () => {
		const r = rig();
		for (let i = 0; i < 6; i++) {
			r.graph.upsertSource(notes(`s${i}`));
			r.graph.appendNode(node(`n${i}`, `st${i}`, `s${i}`));
		}
		deleteSource(r, "s2");
		const expected = ["n0", "n1", "n3", "n4", "n5"]; // written here, not read back
		purgeHistory(r.db, r.file);
		assert.deepEqual(nodeIds(r), expected);
		r.db.close();
		const r2 = rig(r.file);
		assert.deepEqual(nodeIds(r2), expected);
		const before = logCount(r2.db);
		r2.graph.appendNode(node("n9", "after", "s0"));
		assert.equal(logCount(r2.db), before + 1, "a write after purge seals one commit");
		assert.deepEqual(nodeIds(r2), [...expected, "n9"]);
		r2.db.close();
	});
});

/** Wrap a driver so every call lands in `events`. */
function spy(db: SqlDriver, events: string[]): SqlDriver {
	return {
		engine: db.engine,
		engineVersion: db.engineVersion,
		exec: (s) => (events.push(`exec ${s}`), db.exec(s)),
		run: (s, ...p) => (events.push(`run ${s}`), db.run(s, ...p)),
		all: (s, ...p) => db.all(s, ...p),
		get: (s, ...p) => db.get(s, ...p),
		transaction: (f) => db.transaction(f),
		seal: (m) => (events.push("seal"), db.seal(m)),
		head: () => db.head(),
		close: () => db.close(),
	};
}

describe("P3 readers", () => {
	test("pinned readers close before the backup and the squash; a closed reader throws", () => {
		const r = rig();
		r.graph.upsertSource(notes("a"));
		r.graph.appendNode(node("a", "x", "a"));
		const events: string[] = [];
		const pinned = openReaderAt(r.file, r.db.head() as string);
		const wrapped: SqlDriver = { ...pinned, close: () => (events.push("reader close"), pinned.close()) };
		purgeHistory(spy(r.db, events), r.file, { readers: [wrapped] });
		const first = (re: RegExp) => events.findIndex((e) => re.test(e));
		assert.equal(first(/reader close/), 0, "closed before anything else");
		assert.ok(first(/VACUUM/) > first(/reader close/), "reader closed before the backup");
		assert.ok(first(/dolt_reset/) > first(/VACUUM/), "backup before the squash");
		assert.ok(first(/^seal$/) > first(/dolt_reset/));
		assert.throws(() => pinned.all("SELECT 1"), "a closed reader throws");
		r.db.close();
	});
});

describe("P4 backup", () => {
	test("exists before the squash, opens, keeps old history and the text, is never overwritten", () => {
		const r = rig();
		const gone = marker("GONE");
		r.graph.upsertSource(notes("d"));
		r.graph.appendNode(node("d", gone, "d"));
		deleteSource(r, "d");
		const oldHashes = logHashes(r.db);
		const events: string[] = [];
		const seen: boolean[] = [];
		const checking = spy(r.db, events);
		const origSeal = checking.seal;
		checking.seal = (m) => (seen.push(backups(r.file).length === 1), origSeal(m));
		const now = () => new Date("2030-01-02T03:04:05.678Z");
		const res = purgeHistory(checking, r.file, { now });
		assert.deepEqual(seen, [true], "the backup existed when the squash committed");
		assert.match(path.basename(res.backupPath), /^s\d+\.bak-purge-2030-01-02T03-04-05-678Z\.doltlite$/);
		const bak = openDoltlite(res.backupPath, { readOnly: true });
		for (const h of oldHashes) assert.ok(logHashes(bak).includes(h), "backup keeps old history");
		assert.ok(scan(bak, res.backupPath, gone, []).bytes && scan(bak, res.backupPath, gone, oldHashes).history, "backup still contains the text, so the warning is true");
		bak.close();
		const before = sha(res.backupPath);
		const commits = logHashes(r.db);
		assert.throws(() => purgeHistory(r.db, r.file, { now }), /already exists/);
		assert.equal(sha(res.backupPath), before, "never overwritten");
		assert.deepEqual(logHashes(r.db), commits, "refusal changed nothing");
		r.db.close();
	});

	test("a failing backup leaves commits and bytes untouched and rethrows", () => {
		const r = rig();
		const gone = marker("GONE");
		r.graph.upsertSource(notes("d"));
		r.graph.appendNode(node("d", gone, "d"));
		const commits = logHashes(r.db);
		const bytes = sha(r.file);
		const faulty = faultyDriver(r.db, { kind: "before", nth: 1, match: /VACUUM/ });
		assert.throws(() => purgeHistory(faulty, r.file), InjectedFault);
		assert.ok(faulty.fired);
		assert.deepEqual(logHashes(r.db), commits);
		assert.equal(sha(r.file), bytes);
		assert.equal(backups(r.file).length, 0);
		r.db.close();
	});
});

describe("P5 refusals", () => {
	test("a sqlite driver is refused before any call", () => {
		const boom = () => {
			throw new Error("touched");
		};
		const fake = { engine: "sqlite", engineVersion: "x", exec: boom, run: boom, all: boom, get: boom, transaction: boom, seal: boom, head: boom, close: boom } as unknown as SqlDriver;
		assert.throws(() => purgeHistory(fake, path.join(dir, "nope")), PurgeRefusedError);
	});

	for (const [what, sql] of [["branch", "SELECT dolt_branch('other')"], ["tag", "SELECT dolt_tag('v1')"]] as const)
		test(`an extra ${what} is refused and nothing changes`, () => {
			const r = rig();
			r.graph.appendNode(node("a", "x", "a"));
			r.db.exec(sql);
			const commits = logHashes(r.db);
			const bytes = sha(r.file);
			assert.throws(() => purgeHistory(r.db, r.file), PurgeRefusedError);
			assert.deepEqual(logHashes(r.db), commits);
			assert.equal(sha(r.file), bytes);
			assert.equal(backups(r.file).length, 0, "no backup either");
			r.db.close();
		});
});

/** A data folder with a doltlite marker and one store holding the text. */
function dataFolder(backend = "doltlite") {
	const folder = fs.mkdtempSync(path.join(dir, "data-"));
	fs.writeFileSync(path.join(folder, "storage.json"), JSON.stringify({ backend, layout: 1 }));
	const store = path.join(folder, "graph.doltlite");
	const r = rig(store);
	const gone = marker("GONE");
	r.graph.upsertSource(notes("d"));
	r.graph.appendNode(node("d", gone, "d"));
	deleteSource(r, "d");
	r.db.close();
	return { folder, store, gone };
}
const cli = (...argv: string[]) => {
	const out: string[] = [];
	const err: string[] = [];
	const code = runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
	return { code, out: out.join("\n"), err: err.join("\n") };
};
const unchanged = (f: { folder: string; store: string }, bytes: string) => {
	assert.equal(sha(f.store), bytes);
	assert.equal(backups(f.store).length, 0);
	assert.deepEqual(fs.readdirSync(f.folder).filter((x) => x.endsWith(".lock")), [], "no lock left behind");
};

describe("P5 CLI", () => {
	test("without --yes: explains, exits 2, touches nothing", () => {
		const f = dataFolder();
		const bytes = sha(f.store);
		const r = cli("purge", "--data-dir", f.folder);
		assert.equal(r.code, 2);
		const approved = `Purge history permanently erases all earlier versions of your graph, including anything you deleted. This can't be undone. A backup is saved at ${path.join(f.folder, "graph.bak-purge-<timestamp>.doltlite")}; it still contains the deleted content until you delete that file.`;
		assert.ok(r.out.includes(approved), r.out);
		unchanged(f, bytes);
	});

	for (const backend of ["sqlite", "file"])
		test(`a ${backend} data folder is refused`, () => {
			const f = dataFolder(backend);
			if (backend === "file") fs.rmSync(path.join(f.folder, "storage.json")); // missing marker = file
			const bytes = sha(f.store);
			const r = cli("purge", "--data-dir", f.folder, "--yes");
			assert.equal(r.code, 1);
			assert.ok(r.err.includes(PURGE_TEXT.refuseBackend(backend)));
			unchanged(f, bytes);
		});

	test("a held lock is refused, the holder is named, nothing changes", () => {
		const f = dataFolder();
		const bytes = sha(f.store);
		const held = acquireStoreLock(f.store);
		try {
			const r = cli("purge", "--data-dir", f.folder, "--yes");
			assert.equal(r.code, 1);
			assert.ok(r.err.includes(`pid ${process.pid}`), r.err);
			assert.equal(backups(f.store).length, 0);
			assert.equal(sha(f.store), bytes);
		} finally {
			held.release();
		}
	});

	test("--yes purges (leading -- tolerated), prints counts, backup and warning; the text is gone", () => {
		const f = dataFolder();
		const hashes = (() => {
			const d = openDoltlite(f.store, { readOnly: true });
			try {
				return logHashes(d);
			} finally {
				d.close();
			}
		})();
		const r = cli("--", "purge", "--data-dir", f.folder, "--yes");
		assert.equal(r.code, 0, r.err);
		const [bak] = backups(f.store);
		assert.ok(bak);
		assert.ok(r.out.includes(`A backup is saved at ${path.join(f.folder, bak)}; it still contains the deleted content until you delete that file.`), r.out);
		assert.match(r.out, /purged: \d+ commits -> 2/);
		const d = openDoltlite(f.store, { readOnly: true });
		assert.deepEqual(scan(d, f.store, f.gone, hashes), { log: false, history: false, at: false, refused: scan(d, f.store, f.gone, hashes).refused, bytes: false });
		d.close();
		console.log(`FACT CLI: ${r.out.split("\n")[0]}`);
	});

	test("no subcommand or an unknown one prints usage and exits 1", () => {
		for (const argv of [[], ["nope"]]) {
			const r = cli(...argv);
			assert.equal(r.code, 1);
			assert.ok(r.err.includes(PURGE_TEXT.usage));
		}
	});
});

describe("P6 crash, repeat, root-only", () => {
	test("a crash between reset and commit loses no rows; recover-at-open commits them", () => {
		const r = rig();
		for (let i = 0; i < 4; i++) {
			r.graph.upsertSource(notes(`s${i}`));
			r.graph.appendNode(node(`n${i}`, `st${i}`, `s${i}`));
		}
		const faulty = faultyDriver(r.db, { kind: "seal" });
		assert.throws(() => purgeHistory(faulty, r.file), InjectedFault);
		assert.ok(faulty.fired);
		r.db.close();
		const again = rig(r.file);
		assert.deepEqual(nodeIds(again), ["n0", "n1", "n2", "n3"]);
		assert.equal(again.db.get<{ message: string }>("SELECT message FROM dolt_log LIMIT 1")?.message, RECOVER_MESSAGE);
		again.db.close();
	});

	test("a repeat purge works and loses nothing", () => {
		const r = rig();
		r.graph.upsertSource(notes("a"));
		r.graph.appendNode(node("a", "x", "a"));
		purgeHistory(r.db, r.file, { now: () => new Date(1) });
		const second = purgeHistory(r.db, r.file, { now: () => new Date(2) });
		assert.equal(second.commitsAfter, 2);
		assert.deepEqual(nodeIds(r), ["a"]);
		r.db.close();
	});

	test("a root-only store is safe", () => {
		const file = path.join(dir, `root${n++}.doltlite`);
		const db = openDoltlite(file, { lock: lockOf(file) });
		db.exec("CREATE TABLE t (x INTEGER)");
		db.exec("INSERT INTO t VALUES (1)");
		const res = purgeHistory(db, file);
		assert.ok(res.commitsAfter <= 2);
		assert.deepEqual(db.all("SELECT x FROM t"), [{ x: 1 }]);
		db.close();
	});
});

describe("P7 model: random append/delete/seal sequences", () => {
	type Op = { t: "add" } | { t: "del"; at: number } | { t: "seal" };
	const ops = fc.array(fc.oneof(fc.constant<Op>({ t: "add" }), fc.nat(9).map<Op>((at) => ({ t: "del", at })), fc.constant<Op>({ t: "seal" })), { minLength: 1, maxLength: 14 });

	test("live rows equal the model, exactly two commits, deleted markers are not in the bytes", () => {
		fc.assert(
			fc.property(ops, (sequence) => {
				const r = rig();
				const tag = randomUUID();
				let i = 0;
				const model: { id: string; text: string }[] = []; // live nodes in append order
				const dead: string[] = [];
				for (const op of sequence) {
					if (op.t === "add") {
						const id = `n${i}`;
						const text = `${tag}-t${i++}`;
						r.graph.upsertSource(notes(id));
						r.graph.appendNode(node(id, text, id));
						model.push({ id, text });
					} else if (op.t === "del" && model.length > 0) {
						const [gone] = model.splice(op.at % model.length, 1);
						deleteSource(r, gone!.id);
						dead.push(gone!.text);
					} else r.db.seal("manual"); // clean tree: a no-op seal
				}
				const hashes = logHashes(r.db);
				purgeHistory(r.db, r.file);
				try {
					assert.deepEqual(r.graph.readNodes().map((x) => x.statement), model.map((m) => m.text));
					assert.equal(logCount(r.db), 2);
					for (const text of dead) assert.equal(scan(r.db, r.file, text, hashes).bytes, false);
					for (const m of model) assert.equal(scan(r.db, r.file, m.text, []).bytes, true, "live text is still stored");
				} finally {
					r.db.close();
				}
			}),
			{ numRuns: 12 },
		);
	});
});
