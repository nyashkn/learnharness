import path from "node:path";
import { writeFileAtomicSync } from "./atomic-write.ts";
import { beforeWrite } from "./marker.ts";

/** The remote model catalog snapshot: one JSON file in the data folder (a cache; a manual refresh rebuilds it). */
export const modelCatalogFile = (dataDir: string): string => path.join(/* turbopackIgnore: true */ dataDir, "model-catalog.json");

/** Marker and store lock first: a refresh on a fresh folder must not leave it non-empty without its marker,
 *  or the next open ignores LH_STORAGE and reads the folder as `file`. */
export function writeModelCatalog(dataDir: string, text: string): void {
	beforeWrite(dataDir);
	writeFileAtomicSync(modelCatalogFile(dataDir), text);
}
