/**
 * The catalog snapshot read behind src/store (readModelCatalog): no file, or one larger than the bound, reads as none;
 * anything else reads whole. The expected answer comes from the bytes the test wrote, never from the code under test.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import fc from "fast-check";
import { readModelCatalog } from "../src/store/model-catalog.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-catalog-read-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("a missing snapshot reads as none, and the read creates nothing (no folder, marker or lock)", () => {
	const dir = path.join(root, "fresh");
	assert.equal(readModelCatalog(dir, 1024), null);
	assert.equal(fs.existsSync(dir), false);
});

test("a snapshot reads whole up to the byte bound and as none above it", () => {
	let n = 0;
	fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 40 }), fc.nat(160), (text, bound) => {
		const dir = path.join(root, `case-${n++}`);
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "model-catalog.json"), text);
		assert.equal(readModelCatalog(dir, bound), Buffer.byteLength(text) > bound ? null : text);
	}), { numRuns: 200, examples: [["0123456789", 10], ["0123456789", 9], ["é", 1]] });
});
