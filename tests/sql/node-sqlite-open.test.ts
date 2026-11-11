import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
const { DatabaseSync } = process.getBuiltinModule("node:sqlite"); // import ban targets src; the test needs only the prototype
import { openNodeSqlite } from "../../src/store/sql/drivers/node-sqlite";

test("a failed open closes the handle before rethrowing (lh-dej)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-nsq-"));
	const file = path.join(dir, "bad.sqlite");
	fs.writeFileSync(file, "this is not a database, just text padding ".repeat(40)); // opens lazily, then the first pragma throws
	const close = mock.method(DatabaseSync.prototype, "close");
	try {
		assert.throws(() => openNodeSqlite(file));
		assert.equal(close.mock.callCount(), 1);
	} finally {
		close.mock.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
