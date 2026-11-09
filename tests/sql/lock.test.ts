import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import fc from "fast-check";
import { acquireStoreLock, lockFileFor, pidIsAlive, psProcessStart, StoreLockedError } from "../../src/store/sql/lock";
import { machineId } from "../../src/store/sql/machine-id";

let dir: string;
let n = 0;
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lock-home-")); // machineId() writes under HOME, never the real one
before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lock-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const store = () => path.join(dir, `g${n++}.sqlite`);
const leftovers = () => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("store lock (CB6)", () => {
	test("a second writer is refused and the error names the holder's pid", () => {
		const f = store();
		const a = acquireStoreLock(f, { pid: 4242, host: "h1", isAlive: () => true });
		assert.throws(
			() => acquireStoreLock(f, { pid: 99, host: "h1", isAlive: () => true }),
			(e) => e instanceof StoreLockedError && e.holder?.pid === 4242 && /pid 4242/.test(e.message),
		);
		a.release();
	});

	test("a lock whose pid is dead on this host is reclaimed", () => {
		const f = store();
		acquireStoreLock(f, { pid: 4242, host: "h1" }); // never released: the holder crashed
		const b = acquireStoreLock(f, { pid: 99, host: "h1", isAlive: (pid) => pid !== 4242 });
		assert.equal(JSON.parse(fs.readFileSync(lockFileFor(f), "utf8")).pid, 99);
		b.release();
	});

	test("a lock from another host is never reclaimed, even if the pid looks dead", () => {
		const f = store();
		acquireStoreLock(f, { pid: 4242, host: "other" });
		assert.throws(() => acquireStoreLock(f, { pid: 99, host: "h1", isAlive: () => false }), StoreLockedError);
	});

	test("an unreadable lock file is refused, not reclaimed", () => {
		const f = store();
		fs.writeFileSync(lockFileFor(f), "{not json");
		assert.throws(
			() => acquireStoreLock(f, { isAlive: () => false }),
			(e) => e instanceof StoreLockedError && e.holder === null,
		);
	});

	test("held() follows a model of acquire/release across two contenders", () => {
		type Op = ["acquire" | "release", 0 | 1];
		const op = fc.tuple(fc.constantFrom("acquire", "release"), fc.constantFrom(0, 1)) as fc.Arbitrary<Op>;
		fc.assert(
			fc.property(fc.array(op, { maxLength: 20 }), (ops) => {
				const f = store();
				const handles: (ReturnType<typeof acquireStoreLock> | undefined)[] = [undefined, undefined];
				let owner: 0 | 1 | null = null; // the model: who holds the lock file
				for (const [kind, who] of ops) {
					if (kind === "acquire") {
						if (owner === null) {
							handles[who] = acquireStoreLock(f, { pid: who + 1, host: "h1", isAlive: () => true });
							owner = who;
						} else assert.throws(() => acquireStoreLock(f, { pid: who + 1, host: "h1", isAlive: () => true }), StoreLockedError);
					} else {
						handles[who]?.release();
						if (owner === who) owner = null;
					}
					for (const w of [0, 1] as const) if (handles[w]) assert.equal(handles[w]!.held(), owner === w, `after ${kind} ${who}`);
				}
				handles.forEach((h) => h?.release());
			}),
			{ numRuns: 40 },
		);
	});

	test("release frees the lock, is idempotent, and does not remove a lock someone else now holds", () => {
		const f = store();
		const a = acquireStoreLock(f, { pid: 1, host: "h1", isAlive: () => true });
		a.release();
		a.release();
		assert.ok(!fs.existsSync(lockFileFor(f)));
		const b = acquireStoreLock(f, { pid: 2, host: "h1", isAlive: () => true });
		a.release(); // stale handle
		assert.ok(fs.existsSync(lockFileFor(f)));
		b.release();
	});

	test("no temp files are left behind, on success or refusal", () => {
		const f = store();
		const a = acquireStoreLock(f, { pid: 1, host: "h1", isAlive: () => true });
		assert.throws(() => acquireStoreLock(f, { pid: 2, host: "h1", isAlive: () => true }));
		a.release();
		assert.deepEqual(leftovers(), []);
	});

	test("concurrent reclaim: a writer that took the lock while another judged it stale is not evicted", () => {
		const f = store();
		acquireStoreLock(f, { pid: 7, host: "h1" }); // crashed holder
		let a: ReturnType<typeof acquireStoreLock> | undefined;
		// B reads the stale lock, then (inside its liveness check) A reclaims and links its own lock
		const b = () =>
			acquireStoreLock(f, {
				pid: 20,
				host: "h1",
				isAlive: (pid) => {
					if (pid === 7 && !a) a = acquireStoreLock(f, { pid: 10, host: "h1", isAlive: () => false });
					return false;
				},
			});
		assert.throws(b, (e) => e instanceof StoreLockedError && e.holder?.pid === 10);
		assert.equal(JSON.parse(fs.readFileSync(lockFileFor(f), "utf8")).pid, 10, "A's lock survives");
		a?.release();
		assert.deepEqual(fs.readdirSync(dir).filter((x) => x.includes(".tomb") || x.endsWith(".tmp")), []);
	});

	test("property: a held lock is reclaimed iff same host and holder pid not alive", () => {
		fc.assert(
			fc.property(fc.boolean(), fc.boolean(), (sameHost, alive) => {
				const f = store();
				acquireStoreLock(f, { pid: 7, host: sameHost ? "h1" : "h2" });
				let reclaimed = true;
				try {
					acquireStoreLock(f, { pid: 8, host: "h1", isAlive: () => alive }).release();
				} catch (e) {
					assert.ok(e instanceof StoreLockedError);
					reclaimed = false;
				}
				return reclaimed === (sameHost && !alive);
			}),
			{ numRuns: 40 },
		);
	});

	test("a changed hostname does not matter: the default host is the stable machine id (lh-bzc)", () => {
		const f = store();
		const a = acquireStoreLock(f, { pid: 4242 });
		const host = JSON.parse(fs.readFileSync(lockFileFor(f), "utf8")).host;
		assert.equal(host, machineId());
		assert.notEqual(host, os.hostname());
		a.release();
	});

	describe("recycled pid (lh-bzc)", () => {
		const T0 = Date.parse("2026-01-01T00:00:00Z");
		const hold = (f: string) => {
			acquireStoreLock(f, { pid: 7, host: "h1" }); // never released
			const text = JSON.parse(fs.readFileSync(lockFileFor(f), "utf8"));
			text.startedAt = new Date(T0).toISOString();
			fs.writeFileSync(lockFileFor(f), JSON.stringify(text));
		};
		const take = (f: string, start: (pid: number) => Date | undefined) =>
			acquireStoreLock(f, { pid: 99, host: "h1", isAlive: () => true, processStart: start });

		test("an alive pid that started after the lock was written is reclaimed", () => {
			const f = store();
			hold(f);
			take(f, () => new Date(T0 + 1000)).release();
		});

		test("an alive pid that started before the lock was written is refused", () => {
			const f = store();
			hold(f);
			assert.throws(() => take(f, () => new Date(T0 - 1000)), (e) => e instanceof StoreLockedError && e.holder?.pid === 7);
		});

		test("a start time equal to startedAt is refused (not later)", () => {
			const f = store();
			hold(f);
			assert.throws(() => take(f, () => new Date(T0)), StoreLockedError);
		});

		test("an unknown start time (ps failed) means alive", () => {
			const f = store();
			hold(f);
			assert.throws(() => take(f, () => undefined), StoreLockedError);
		});

		test("property: reclaimed iff the start time is strictly later", () => {
			fc.assert(
				fc.property(fc.integer({ min: -100000, max: 100000 }), (delta) => {
					const f = store();
					hold(f);
					let reclaimed = true;
					try {
						take(f, () => new Date(T0 + delta)).release();
					} catch {
						reclaimed = false;
					}
					return reclaimed === delta > 0;
				}),
				{ numRuns: 40 },
			);
		});

		test("another machine's live-looking lock is refused even if the pid started later", () => {
			const f = store();
			acquireStoreLock(f, { pid: 7, host: "other" });
			assert.throws(() => acquireStoreLock(f, { pid: 99, host: "h1", isAlive: () => true, processStart: () => new Date(Date.now() + 1e6) }), StoreLockedError);
		});
	});

	describe("psProcessStart: every failure mode is undefined (alive)", () => {
		const withPath = (p: string, fn: () => void) => {
			const old = process.env.PATH;
			process.env.PATH = p;
			try { fn(); } finally { process.env.PATH = old; }
		};
		const fakePs = (script: string) => {
			const d = fs.mkdtempSync(path.join(dir, "bin-"));
			fs.writeFileSync(path.join(d, "ps"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
			return d;
		};
		test("no ps on PATH", () => withPath(fs.mkdtempSync(path.join(dir, "empty-")), () => assert.equal(psProcessStart(process.pid), undefined)));
		test("empty output", () => withPath(fakePs("exit 0"), () => assert.equal(psProcessStart(process.pid), undefined)));
		test("unparsable output", () => withPath(fakePs("echo not-a-date"), () => assert.equal(psProcessStart(process.pid), undefined)));
		test("non-zero exit", () => withPath(fakePs("echo 'Sat Nov  8 12:34:56 2026'; exit 1"), () => assert.equal(psProcessStart(process.pid), undefined)));
		test("timeout", () => withPath(fakePs("/bin/sleep 5"), () => assert.equal(psProcessStart(process.pid), undefined)));
		test("the real ps reports this process as started in the past", () => {
			const t = psProcessStart(process.pid);
			assert.ok(t && t.getTime() <= Date.now() && t.getTime() > Date.now() - 24 * 3600 * 1000, String(t));
		});
		// lh-db2: the real ps, no stub, in a child whose TZ differs from the system zone (UTC-11, and UTC itself).
		for (const tz of ["Pacific/Pago_Pago", "Etc/UTC"]) {
			test(`TZ=${tz}: the real ps start time is this process's, and a live holder is refused`, () => {
				const f = store();
				const held = acquireStoreLock(f); // this test process: live, real pid, real host
				try {
					const lockTs = path.resolve(import.meta.dirname, "../../src/store/sql/lock.ts");
					const code = `const { acquireStoreLock, psProcessStart } = await import(${JSON.stringify(lockTs)});
						const expected = Date.now() - process.uptime() * 1000;
						const start = psProcessStart(process.pid)?.getTime() ?? null;
						let refused = null;
						try { acquireStoreLock(${JSON.stringify(f)}).release(); refused = false; } catch (e) { refused = e.name; }
						console.log(JSON.stringify({ expected, start, refused }));`;
					const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
						cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 30000,
						env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", TZ: tz },
					});
					assert.equal(r.status, 0, r.stderr);
					const { expected, start, refused } = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { expected: number; start: number | null; refused: string | false | null };
					assert.ok(start !== null && Math.abs(start - expected) <= 5000, `ps start ${start} vs process start ${expected} (off by ${start === null ? "?" : start - expected} ms)`);
					assert.equal(refused, "StoreLockedError", "a live holder was evicted");
				} finally {
					held.release();
				}
			});
		}
		test("a parseable date is returned", () => withPath(fakePs("echo 'Sat Nov  8 12:34:56 2026'"), () => assert.equal(psProcessStart(1)?.getFullYear(), 2026)));
	});

	test("pidIsAlive: true for this process, false for a pid that has exited", () => {
		assert.equal(pidIsAlive(process.pid), true);
		const dead = spawnSync(process.execPath, ["-e", "0"]).pid as number;
		assert.equal(pidIsAlive(dead), false);
	});
});
