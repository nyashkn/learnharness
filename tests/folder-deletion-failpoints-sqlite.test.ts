// The folder Delete failpoints (folder-deletion-failpoints.ts) on the sqlite backend: LH_STORAGE is read once, at the stores' first import.
process.env.LH_STORAGE = "sqlite";
const { runFailpoints } = await import("./folder-deletion-failpoints.ts");
runFailpoints("sqlite", 25);
export {};
