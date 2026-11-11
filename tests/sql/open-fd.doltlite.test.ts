/**
 * lh-ax3: while this process holds a writable DoltLite handle, a read-only connection that ran a query and closed keeps 1 fd on the
 * engine's lock file until the writer closes (the unix VFS defers the close; GC does not free it). The app open path must therefore never
 * probe while its own writer is open. This measures only that class: GC plus one setImmediate runs before every count (the lh-8jh GC-only leak).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import type { GraphStore } from "../../src/core/ports";
import { createSqlGraphStores, doltliteDbFile, ensureDoltliteDb, releaseGraphDb } from "../../src/store/sql/open";
import { acquireStoreLock, type StoreLock } from "../../src/store/sql/lock";

v8.setFlagsFromString("--expose-gc");
const collect = vm.runInNewContext("gc") as () => void;
const fds = async (): Promise<number> => {
	collect();
	await new Promise<void>((resolve) => setImmediate(resolve));
	return fs.readdirSync("/dev/fd").length;
};

// Every native open, recorded before the driver first loads the addon. `violations` counts read-only opens made while this process holds a live writable handle.
let liveWriters = 0;
let violations = 0;
const mod = createRequire(import.meta.url)("@dolthub/doltlite") as { DatabaseSync: new (target: string, options?: { readOnly?: boolean }) => { close(): void } };
const Original = mod.DatabaseSync;
mod.DatabaseSync = class extends (Original as never as new (t: string, o?: { readOnly?: boolean }) => { close(): void }) {
	private readonly writer: boolean;
	private done = false;
	constructor(target: string, options?: { readOnly?: boolean }) {
		super(target, options);
		this.writer = options?.readOnly !== true;
		if (this.writer) liveWriters++;
		else if (liveWriters > 0) violations++;
	}
	override close(): void {
		if (this.writer && !this.done) { this.done = true; liveWriters--; }
		super.close();
	}
} as never;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-open-fd-"));
after(() => {
	releaseGraphDb(dir);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("lh-ax3: repeated lost-lock re-promotions with a writer open keep the fd count flat", async () => {
	const file = doltliteDbFile(dir);
	const real = acquireStoreLock(file);
	// A fake lock per promotion: the previous one reports lost (held() false), the new one is held. The real lock file stays ours throughout.
	let current: { held: boolean } = { held: true };
	const fresh = (): StoreLock => {
		const mine = { held: true };
		current = mine;
		return { lockFile: real.lockFile, held: () => mine.held && real.held(), release: () => {} };
	};
	ensureDoltliteDb(dir, fresh());
	const positions = { readPositions: () => ({}), writePositions: () => {} };
	const { graphStore } = createSqlGraphStores(dir, positions, () => {}, () => fresh(), "doltlite");
	const write = (i: number) => (graphStore as GraphStore).upsertSource({ id: `s${i}`, filePath: `/x/s${i}`, importedAt: "t" });
	try {
		write(0); // first write: promotes the read-only handle
		const cycle = async (i: number): Promise<void> => {
			current.held = false; // the writer's lock is lost: the next write re-promotes
			write(i);
			await fds(); // a closed writer's unfinalised statements are the GC-only class: free them so the next probe meets no zombie
		};
		for (let i = 1; i <= 3; i++) await cycle(i); // warm-up: also frees the eager read-only open's own GC-class fds
		const afterOne = await fds();
		for (let i = 4; i < 24; i++) await cycle(i);
		const afterN = await fds();
		assert.equal(violations, 0, "a read-only open ran while this process held a writable handle");
		assert.equal(afterN, afterOne, `fd count grew over 20 lost-lock re-promotions: ${afterOne} -> ${afterN}`);
	} finally {
		releaseGraphDb(dir);
		real.release();
	}
});
