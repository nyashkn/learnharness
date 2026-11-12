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

/** lh-7gn: the other submission paths, each held, blocked or proven unreachable while busy. */
const arrow = (name: string) => { const d = all(ts.isVariableDeclaration).find(v => v.name.getText(file) === name); assert.ok(d?.initializer && ts.isArrowFunction(d.initializer), name); return d.initializer; };
const dockText = (name: string) => fs.readFileSync(new URL(`../components/${name}`, import.meta.url), "utf8");

test("prepareThinking (practice thinking) holds a press made while busy or compacting before its busy early return", () => {
	const fn = arrow("prepareThinking"), body = fn.body.getText(file);
	const press = body.indexOf("heldThinking.press("), early = body.indexOf("busyRef.current || compacting) return;");
	assert.ok(press >= 0 && early > press, "heldThinking.press precedes the busy early return");
	assert.match(body.slice(press, early), /busyRef\.current \|\| compacting\)\) return;/, "press is blocked on busy AND compacting");
	const replay = calls("heldThinking.replay");
	assert.equal(replay.length, 1);
	assert.equal(replay[0]!.arguments[0]?.getText(file), "busy || compacting");
	assert.ok((text.match(/heldThinking\.clear\(\)/g) ?? []).length >= 2, "Stop and a chat change clear the held press");
});

test("plugin problem and plugin question docks are unreachable while busy: chat.tsx passes ready = !busy && !compacting and the docks gate every submit path on it", () => {
	assert.match(text, /pluginReady=\{!busy && !compacting && reconciliation === "ready"\}/);
	assert.match(text, /ready: !busy && !compacting && reconciliation === "ready", reconciliation: activeProblemOf/);
	const q = dockText("plugin-question-dock.tsx"), p = dockText("plugin-problem-dock.tsx");
	assert.match(q, /const canSubmit = canonicalReady && ready &&/, "question button");
	assert.match(q, /eligible: key => [^\n]*current\.current\.ready/, "question keyboard submit");
	assert.match(q, /before\.reconciliation !== "ready" \|\| !before\.ready/, "question capture");
	assert.match(p, /const canSubmit = ready && reconciliation === "ready"/, "problem button");
	assert.match(p, /now\.ready && now\.available && now\.reconciliation === "ready"/, "problem keyboard submit");
	assert.match(p, /now\.ready && now\.reconciliation === "ready"/, "problem capture");
});

test("prepareText never drops a press made while busy: busy steers, compacting is unreachable (sendAllowed)", () => {
	const body = arrow("prepareText").body.getText(file);
	const guard = /if \(!target \|\| pendingRef\.current[^\n]*\) return Promise\.resolve\(false\);/.exec(body)?.[0] ?? "";
	assert.ok(guard && !guard.includes("busyRef"), "the early return does not test busy");
	assert.match(body, /if \(busyRef\.current\) return steer\(/);
	assert.match(text, /const sendAllowed = [^\n]*!compacting/);
});
