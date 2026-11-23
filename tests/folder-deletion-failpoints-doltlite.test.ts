// The folder Delete failpoints (folder-deletion-failpoints.ts) on the doltlite backend: LH_STORAGE is read once, at the stores' first import.
import { test } from "node:test";

// A hardcoded literal on purpose: the expected hosts must not be derived from the code under test.
if (["darwin-arm64", "linux-x64"].includes(`${process.platform}-${process.arch}`)) {
	process.env.LH_STORAGE = "doltlite";
	const { runFailpoints } = await import("./folder-deletion-failpoints.ts");
	runFailpoints("doltlite", 15);
} else test("folder Delete failpoints on doltlite", { skip: "doltlite has no adapter on this host" }, () => {});
