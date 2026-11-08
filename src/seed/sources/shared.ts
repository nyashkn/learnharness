import { createHash } from "node:crypto";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { SourceStats } from "../types";

export const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Invalid or out-of-range input is a bad row, not an exception. "auto": above 1e12 is milliseconds, else seconds. */
export function epochToIso(n: number, unit: "s" | "ms" | "auto"): string | null {
	const ms = unit === "ms" || (unit === "auto" && n > 1e12) ? n : n * 1000;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isoOrNull(text: string): string | null {
	const date = new Date(text);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function validRows<S extends TSchema>(rows: readonly unknown[], schema: S, stats: SourceStats) {
	const good: Static<S>[] = [];
	for (const row of rows) {
		if (Value.Check(schema, row)) good.push(row);
		else stats.skipped++;
	}
	return good;
}
