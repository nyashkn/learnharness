/**
 * Preloaded by `pnpm run test`: gives each test file its own LH_DATA_DIR, so files running in
 * parallel never contend for the store lock or write to the repo's data/ folder.
 * It runs before any app import, because config.ts reads LH_DATA_DIR once when first loaded.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The `node --test` parent also runs this preload. Only per-file children have NODE_TEST_CONTEXT;
// if the parent set the variable, every child would inherit that one shared folder.
if (process.env.NODE_TEST_CONTEXT && !process.env.LH_DATA_DIR) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-data-"));
	process.env.LH_DATA_DIR = dir;
	process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}
