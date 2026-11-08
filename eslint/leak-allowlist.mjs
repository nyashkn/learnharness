// Every src/server import of a store adapter that predates the server->store zone,
// one entry per import line (module is relative to src/store). P1 moves these behind
// src/server/stores.ts and deletes each entry; do not add new ones.
// tests/leak-allowlist.test.ts keeps this list equal to the real imports.

// Lower this as entries go. It only ever goes down.
export const maxLeaks = 0;

export const leakAllowlist = [];
