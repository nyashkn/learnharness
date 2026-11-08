import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, describe, test } from "node:test";
import { loadMachineId } from "../../src/store/sql/machine-id";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mid-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const home = () => path.join(root, `h${n++}`);
const idFile = (h: string) => path.join(h, ".learnharness", "machine-id");

describe("machine id (lh-bzc)", () => {
	test("created once, then stable across calls; not the hostname", () => {
		const h = home();
		const a = loadMachineId(h);
		assert.equal(loadMachineId(h), a);
		assert.equal(fs.readFileSync(idFile(h), "utf8").trim(), a);
		assert.notEqual(a, os.hostname());
		assert.notEqual(a, "");
	});

	test("an existing id file is read back, not replaced", () => {
		const h = home();
		fs.mkdirSync(path.dirname(idFile(h)), { recursive: true });
		fs.writeFileSync(idFile(h), "fixed-id\n");
		assert.equal(loadMachineId(h), "fixed-id");
	});

	test("an empty id file falls back to the hostname", () => {
		const h = home();
		fs.mkdirSync(path.dirname(idFile(h)), { recursive: true });
		fs.writeFileSync(idFile(h), "  \n");
		assert.equal(loadMachineId(h), os.hostname());
	});

	test("an unwritable home falls back to the hostname", () => {
		const h = home();
		fs.writeFileSync(h, "a file, so mkdir under it fails"); // ENOTDIR
		assert.equal(loadMachineId(h), os.hostname());
	});

	test("two racing processes creating the id agree", async () => {
		const h = home();
		const src = path.resolve(import.meta.dirname, "../../src/store/sql/machine-id.ts");
		const code = `import { loadMachineId } from ${JSON.stringify(src)}; console.log(loadMachineId(${JSON.stringify(h)}));`;
		const run = () =>
			new Promise<string>((resolve, reject) => {
				const c = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], { env: { PATH: process.env.PATH, NODE_ENV: "test" } });
				let out = "";
				c.stdout.on("data", (d) => (out += d));
				c.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
			});
		const ids = await Promise.all([run(), run(), run(), run()]);
		assert.equal(new Set(ids).size, 1, ids.join(","));
		assert.equal(ids[0], fs.readFileSync(idFile(h), "utf8").trim());
	});
});
