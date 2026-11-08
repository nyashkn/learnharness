import assert from "node:assert/strict";
import { test } from "node:test";

// shortcut: placeholder so test:contract has a file before C1 lands the real suite; C1 deletes it.
test("contract suite is wired into the gate", () => {
	assert.equal(process.env.NODE_ENV, "test");
});
