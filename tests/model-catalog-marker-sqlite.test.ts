// The catalog marker guard (model-catalog-marker.ts) on the sqlite backend: LH_STORAGE is read once, at the stores' first import.
process.env.LH_STORAGE = "sqlite";
const { runMarkerGuard } = await import("./model-catalog-marker.ts");
runMarkerGuard("sqlite");
export {};
