// Every src/server import of a store adapter that predates the server->store zone,
// one entry per import line (module is relative to src/store). P1 moves these behind
// src/server/stores.ts and deletes each entry; do not add new ones.
export const leakAllowlist = [
	{ file: "src/server/claude-code-config.ts", module: "settings.ts" },
	{ file: "src/server/custom-provider-auth.ts", module: "auth.ts" },
	{ file: "src/server/custom-provider-http.ts", module: "settings.ts" },
	{ file: "src/server/custom-provider-http.ts", module: "auth.ts" },
	{ file: "src/server/custom-provider.ts", module: "settings.ts" },
	{ file: "src/server/file-access.ts", module: "settings.ts" },
	{ file: "src/server/index.ts", module: "render-settings.ts" },
	{ file: "src/server/index.ts", module: "settings.ts" },
	{ file: "src/server/index.ts", module: "prompt-overrides.ts" },
	{ file: "src/server/index.ts", module: "auth.ts" },
	{ file: "src/server/keys.ts", module: "auth.ts" },
	{ file: "src/server/model-catalog.ts", module: "settings.ts" },
	{ file: "src/server/observability.ts", module: "chats.ts" }, // import
	{ file: "src/server/observability.ts", module: "chats.ts" }, // re-export
];
