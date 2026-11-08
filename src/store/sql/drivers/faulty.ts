/**
 * TEST-ONLY decorator over any SqlDriver: scripted failure at a chosen step (CB3 fault injection, bead lh-o0a).
 * Production code must never import this file (tests/contract/failpoints-coverage.contract.ts greps src/ for it).
 *
 * Steps counted are WRITES: every exec() and run() whose sql matches `match` (default: all). Reads never count.
 *   before    throw before the nth write reaches the engine       (a crash just before the step)
 *   after     run the nth write, then throw                        (a crash just after the step)
 *   enospc    throw a disk-full error before the nth write         (SQLITE_FULL, errcode 13)
 *   commit    run all of the outermost transaction's callback, then throw instead of COMMIT
 *   seal      let COMMIT succeed, then make seal() throw           (seal failure after COMMIT)
 */
import type { SqlDriver, SqlValue } from "../driver";

export type Fault =
	| { kind: "before" | "after" | "enospc"; nth: number; match?: RegExp }
	| { kind: "commit" }
	| { kind: "seal" };

export interface FaultyDriver extends SqlDriver {
	/** True once the scripted failure has been thrown. A test that expects a fault must assert this. */
	readonly fired: boolean;
	/** Writes seen so far (sql text), in order. */
	readonly writes: readonly string[];
}

export class InjectedFault extends Error {
	constructor(readonly fault: Fault, message: string, readonly code?: string) {
		super(message);
		this.name = "InjectedFault";
	}
}

export function faultyDriver(inner: SqlDriver, fault: Fault): FaultyDriver {
	let fired = false;
	let seen = 0;
	let depth = 0;
	const writes: string[] = [];
	const fire = (msg: string, code?: string): never => {
		fired = true;
		throw new InjectedFault(fault, msg, code);
	};
	/** Decide for one write: returns the fault to apply to this statement, if any. */
	const step = (sql: string): "before" | "after" | "enospc" | null => {
		writes.push(sql);
		if (fault.kind !== "before" && fault.kind !== "after" && fault.kind !== "enospc") return null;
		if (fired || (fault.match && !fault.match.test(sql))) return null;
		return ++seen === fault.nth ? fault.kind : null;
	};
	const guard = <T>(sql: string, go: () => T): T => {
		const f = step(sql);
		if (f === "before") return fire(`injected: crash before write #${seen}`);
		if (f === "enospc") return fire("injected: database or disk is full", "SQLITE_FULL");
		const r = go();
		if (f === "after") fire(`injected: crash after write #${seen}`);
		return r;
	};
	return {
		get engine() { return inner.engine; },
		get engineVersion() { return inner.engineVersion; },
		get fired() { return fired; },
		get writes() { return writes; },
		exec: (sql) => guard(sql, () => inner.exec(sql)),
		run: (sql, ...params: SqlValue[]) => guard(sql, () => inner.run(sql, ...params)),
		all: (sql, ...params) => inner.all(sql, ...params),
		get: (sql, ...params) => inner.get(sql, ...params),
		transaction<T>(fn: () => T): T {
			const outer = depth === 0;
			depth++;
			try {
				return inner.transaction(() => {
					const r = fn();
					if (outer && fault.kind === "commit") fire("injected: failure on COMMIT");
					return r;
				});
			} finally {
				depth--;
			}
		},
		seal(message) {
			if (fault.kind === "seal" && !fired) fire("injected: seal failed after COMMIT");
			return inner.seal(message);
		},
		head: () => inner.head(),
		close: () => inner.close(),
	};
}
