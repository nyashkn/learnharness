// The catalog marker guard (model-catalog-marker.ts) on the file backend: LH_STORAGE is read once, at the stores' first import.
process.env.LH_STORAGE = "file";
const { runMarkerGuard } = await import("./model-catalog-marker.ts");
runMarkerGuard("file");
export {};
