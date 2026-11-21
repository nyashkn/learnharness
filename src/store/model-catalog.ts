import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "./atomic-write.ts";
import { beforeWrite } from "./marker.ts";

/** The remote model catalog snapshot: one JSON file in the data folder (a cache; a manual refresh rebuilds it). */
export const modelCatalogFile = (dataDir: string): string => path.join(/* turbopackIgnore: true */ dataDir, "model-catalog.json");

/** The snapshot's text, or null when there is none or it is larger than `maxBytes` (the caller then starts from the
 *  bundled catalog). A read never takes the first-write gate: it creates nothing. */
export function readModelCatalog(dataDir: string, maxBytes: number): string | null {
	const file = modelCatalogFile(dataDir);
	const size = fs.statSync(file, { throwIfNoEntry: false })?.size;
	return size === undefined || size > maxBytes ? null : fs.readFileSync(file, "utf-8");
}

/** Marker and store lock first: a refresh on a fresh folder must not leave it non-empty without its marker,
 *  or the next open ignores LH_STORAGE and reads the folder as `file`. */
export function writeModelCatalog(dataDir: string, text: string): void {
	beforeWrite(dataDir);
	writeFileAtomicSync(modelCatalogFile(dataDir), text);
}
