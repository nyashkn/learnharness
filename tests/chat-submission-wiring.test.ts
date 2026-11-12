/** Source guard (no ChatView render harness exists): chat.tsx must keep calling the shared
 * hold/replay and interceptor code in components/held-builtin-submission.ts, whose behaviour
 * tests/held-builtin-submission.test.ts proves. Each assertion names a break that otherwise
 * leaves every unit test green (lh-osh, lh-5zn).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const text = fs.readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("chat.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const all = <T extends ts.Node>(guard: (n: ts.Node) => n is T): T[] => { const out: T[] = []; const visit = (n: ts.Node) => { if (guard(n)) out.push(n); ts.forEachChild(n, visit); }; visit(file); return out; };
const calls = (name: string) => all(ts.isCallExpression).filter(c => c.expression.getText(file) === name);

test("prepareBuiltin holds a press made while busy or compacting before any busy early return", () => {
	const decl = all(ts.isVariableDeclaration).find(d => d.name.getText(file) === "prepareBuiltin");
	assert.ok(decl?.initializer && ts.isArrowFunction(decl.initializer), "prepareBuiltin arrow function");
	const body = decl.initializer.body;
	const press = all(ts.isCallExpression).filter(c => c.pos >= body.pos && c.end <= body.end && c.expression.getText(file) === "heldBuiltin.press");
	assert.equal(press.length, 1, "prepareBuiltin calls heldBuiltin.press once");
	const blocked = press[0]!.arguments[2]?.getText(file) ?? "";
	assert.ok(blocked.includes("busyRef.current") && blocked.includes("compacting"), `press is blocked on busy AND compacting, got: ${blocked}`);
	for (const ret of all(ts.isReturnStatement).filter(r => r.pos >= body.pos && r.end <= body.end)) {
		const guard = ts.isIfStatement(ret.parent) ? ret.parent : undefined;
		if (guard && guard.expression.getText(file).includes("busyRef.current") && !guard.expression.getText(file).includes("heldBuiltin.press")) {
			assert.ok(press[0]!.getStart(file) < guard.getStart(file), "heldBuiltin.press comes before the early return guarded on busy");
		}
	}
});

test("runSubmission passes the plugin manager's submission interceptors to the shared attempt", () => {
	const attempt = calls("runSubmissionAttempt");
	assert.equal(attempt.length, 1);
	const arg = attempt[0]!.arguments[0];
	assert.ok(arg && ts.isObjectLiteralExpression(arg));
	const registrations = arg.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === "registrations") as ts.PropertyAssignment | undefined;
	assert.ok(registrations?.initializer.getText(file).includes("captureSubmissionInterceptors()"), "registrations reads captureSubmissionInterceptors()");
});

test("the replay effect waits on busy || compacting and re-runs when compacting changes", () => {
	const replay = calls("heldBuiltin.replay");
	assert.equal(replay.length, 1);
	assert.equal(replay[0]!.arguments[0]?.getText(file), "busy || compacting");
	const effect = ts.findAncestor(replay[0]!.parent, ts.isCallExpression);
	assert.ok(effect && effect.expression.getText(file) === "useEffect", "replay runs inside useEffect");
	const deps = effect.arguments[1];
	assert.ok(deps && ts.isArrayLiteralExpression(deps) && deps.elements.some(e => e.getText(file) === "compacting") && deps.elements.some(e => e.getText(file) === "busy"), "deps include busy and compacting");
});
