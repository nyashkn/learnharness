/**
 * The remote model catalog snapshot is a data-folder write, so it goes through the first-write gate:
 * on a fresh folder with LH_STORAGE=sqlite, a refresh leaves the marker beside model-catalog.json.
 * Without it the folder would be non-empty with no marker, and the next open would ignore LH_STORAGE
 * and read it as `file`. Expectations come from the folder listing, never from the code under test.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { AUTH_PROVIDER_ENV_VARS } from "../src/core/auth-keys.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-catalog-marker-"));
const data = path.join(root, "data");
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.LH_STORAGE = "sqlite";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
for (const key of AUTH_PROVIDER_ENV_VARS) delete process.env[key];
process.env.OPENAI_API_KEY = "synthetic-openai-test-key";

const { initializeModelCatalog, refreshModelCatalog } = await import("../src/server/remote-model-catalog.ts");
const { releaseStoreLock } = await import("../src/store/marker.ts");
after(() => { releaseStoreLock(data); fs.rmSync(root, { recursive: true, force: true }); });

test("a catalog refresh on a fresh sqlite folder writes the marker with the snapshot", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ models: [{
		id: "test-marker-model", name: "Marker", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1",
		input: ["text"], reasoning: false, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_000, maxTokens: 1_000,
	}] }));
	assert.equal(fs.existsSync(data), false, "fresh: the folder does not exist yet");
	initializeModelCatalog();
	assert.equal(await refreshModelCatalog(), "updated");
	const names = fs.readdirSync(data);
	assert.ok(names.includes("model-catalog.json"), `snapshot written: ${names.join(", ")}`);
	assert.ok(names.includes("storage.json"), `marker written with it: ${names.join(", ")}`);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "storage.json"), "utf8")).backend, "sqlite");
	assert.ok(names.includes("graph.sqlite"), "the marker never names a missing store");
});
