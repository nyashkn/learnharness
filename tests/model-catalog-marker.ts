/**
 * The remote model catalog snapshot is a data-folder write, so it goes through the first-write gate:
 * on a fresh folder, a refresh leaves the marker for whichever backend LH_STORAGE names beside model-catalog.json
 * (the entry files set it: model-catalog-marker-{file,sqlite,doltlite}.test.ts). Without it the folder would be
 * non-empty with no marker, and the next open would ignore LH_STORAGE and read it as `file`.
 * Expectations come from the folder listing and the literals below, never from the code under test.
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
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
for (const key of AUTH_PROVIDER_ENV_VARS) delete process.env[key];
process.env.OPENAI_API_KEY = "synthetic-openai-test-key";

const { initializeModelCatalog, refreshModelCatalog } = await import("../src/server/remote-model-catalog.ts");
const { storageBackend } = await import("../src/server/stores.ts");
const { releaseStoreLock } = await import("../src/store/marker.ts");
after(() => { releaseStoreLock(data); fs.rmSync(root, { recursive: true, force: true }); });

/** The store file each backend's marker names (file keeps its graph in graph/, which a refresh does not create). */
const STORE_FILES = { file: null, sqlite: "graph.sqlite", doltlite: "graph.doltlite" } as const;

export function runMarkerGuard(backend: keyof typeof STORE_FILES): void {
	test(`a catalog refresh on a fresh ${backend} folder writes the marker with the snapshot`, async (t) => {
		assert.equal(storageBackend, backend, "the stores run on the backend under test");
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
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "storage.json"), "utf8")).backend, backend);
		const store = STORE_FILES[backend];
		if (store) assert.ok(names.includes(store), "the marker never names a missing store");
		for (const other of Object.values(STORE_FILES)) if (other && other !== store) assert.ok(!names.includes(other), `no ${other} in a ${backend} folder`);
	});
}
