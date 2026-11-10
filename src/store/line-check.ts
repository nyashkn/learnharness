import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";

const compiled = new WeakMap<TSchema, (value: unknown) => boolean>();

/** Strict shape check of one ledger line: `Check` ONLY, never Convert/Clean (lines are verbatim, CB5). Same verdicts as
 *  `Value.Check`, but the schema is compiled once per schema object (a 30k-line ledger read: ~556 ms interpreted, ~2 ms compiled). */
export function lineCheck(schema: TSchema, value: unknown): boolean {
	let check = compiled.get(schema);
	if (!check) {
		const validator = Compile(schema);
		compiled.set(schema, (check = (v) => validator.Check(v)));
	}
	return check(value);
}
