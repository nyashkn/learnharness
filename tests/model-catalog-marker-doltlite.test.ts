// The catalog marker guard (model-catalog-marker.ts) on the doltlite backend: LH_STORAGE is read once, at the stores' first import.
import { test } from "node:test";

// A hardcoded literal on purpose: the expected hosts must not be derived from the code under test.
if (["darwin-arm64", "linux-x64"].includes(`${process.platform}-${process.arch}`)) {
	process.env.LH_STORAGE = "doltlite";
	const { runMarkerGuard } = await import("./model-catalog-marker.ts");
	runMarkerGuard("doltlite");
} else test("catalog marker guard on doltlite", { skip: "doltlite has no adapter on this host" }, () => {});
