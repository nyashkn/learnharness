// The folder Delete failpoints (folder-deletion-failpoints.ts) on the file backend: LH_STORAGE is read once, at the stores' first import.
process.env.LH_STORAGE = "file";
const { runFailpoints } = await import("./folder-deletion-failpoints.ts");
runFailpoints("file", 25);
export {};
