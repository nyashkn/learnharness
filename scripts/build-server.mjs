/**
 * build-server.mjs — curate the Electron shell's server payload.
 *
 * `next build` (output: "standalone") produces .next/standalone/ with
 * server.js + the traced node_modules subset, but leaves two pieces
 * outside that the docs require us to copy: public/ and .next/static/.
 * This script finishes the job and sanity-checks the result — including
 * the exclusion that keeps the repo's real data/ OUT of the bundle
 * (see next.config.ts outputFileTracingExcludes). It also removes two
 * exact build-only paths the tracer sweeps in: old installers and the
 * development Electron runtime. Broad trace exclusions break externals.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");

const copyTree = (from, to) => {
	fs.cpSync(from, to, { recursive: true });
};

const exists = (p) => fs.existsSync(p);

if (!exists(path.join(STANDALONE, "server.js"))) {
	console.error("[build-server] .next/standalone/server.js missing — run `next build` first (output: 'standalone').");
	process.exit(1);
}

// 1) Static assets: public/ → standalone/public, .next/static → standalone/.next/static
const staticFrom = path.join(ROOT, ".next", "static");
const staticTo = path.join(STANDALONE, ".next", "static");
if (!exists(staticFrom)) {
	console.error("[build-server] .next/static missing — the build looks incomplete.");
	process.exit(1);
}
copyTree(staticFrom, staticTo);
if (exists(path.join(ROOT, "public"))) {
	copyTree(path.join(ROOT, "public"), path.join(STANDALONE, "public"));
}

// 2) Safety: the repo's real data/ must NEVER ride along in the bundle.
const leakedData = path.join(STANDALONE, "data");
if (exists(leakedData)) {
	console.error("[build-server] REFUSING: standalone contains a data/ directory — repo session data would ship in the app.");
	console.error("             Check outputFileTracingExcludes in next.config.ts.");
	process.exit(1);
}

// 2b) Safety: the repo's dev SECRETS must never ride along either — the
// same trace sweep that catches data/ shipped the repo-root auth.json
// (the DEV BYOK key store, 0600) byte-identical into the DMG (caught in
// the 2026-10-08 payload audit; excluded in next.config.ts — this guard
// makes a regression loud instead of silent).
const subscriptionSecrets = fs.readdirSync(STANDALONE).filter((name) => /^(chatgpt|github-copilot|xai)-credentials\.json/.test(name));
for (const secret of ["auth.json", ...subscriptionSecrets, ".env", ".env.local"]) {
	if (exists(path.join(STANDALONE, secret))) {
		console.error(`[build-server] REFUSING: standalone contains ${secret} — dev secrets would ship in the app.`);
		console.error("             Check outputFileTracingExcludes in next.config.ts.");
		process.exit(1);
	}
}

// 2c) Payload curation (2026-10-11): the trace sweep can copy repo-root
// dist/ (previous installers, recursively) and the development Electron
// runtime (the demo helper's dev-only require). Neither belongs in the
// server: packaged helpers use process.execPath, the app's own binary.
// Remove ONLY these standalone-root paths AFTER tracing — excluding a
// generic dist/** earlier broke pi-ai / pi-agent-core's runtime dist/.
// Never touch ROOT/dist or ROOT/node_modules/electron (the running app
// and the build runtime); native canvas/resvg packages stay untouched.
for (const extra of ["dist", path.join("node_modules", "electron")]) {
	const target = path.join(STANDALONE, extra);
	if (exists(target)) {
		fs.rmSync(target, { recursive: true, force: true });
		console.log(`[build-server] removed build-only payload: ${extra}`);
	}
}

// 3) Sanity: the runtime-read prompt assets must be present (the teacher
//    agent reads them from disk at request time).
for (const asset of [
	path.join("src", "agent", "system-prompt.md"),
	path.join("src", "agent", "prompts", "teacher", "20-teaching.md"),
]) {
	if (!exists(path.join(STANDALONE, asset))) {
		console.error(`[build-server] prompt asset missing from the trace: ${asset}`);
		process.exit(1);
	}
}

// 4) DoltLite (bead D2): exactly THIS platform's addon ships, never the CLI
//    or another platform's prebuild (~45 MB for five platforms, see
//    next.config.ts). Missing addon is fatal on macOS arm64 (the shipping
//    target); win/linux are continue-on-error until D5, so warn only.
const DOLT_DIR = path.join(STANDALONE, "node_modules", "@dolthub", "doltlite");
const DOLT_PREBUILDS = path.join(DOLT_DIR, "prebuilds");
const DOLT_PLATFORM = `${process.platform}-${process.arch}`;
const doltMissing = ["index.js", "package.json", path.join("prebuilds", DOLT_PLATFORM, "doltlite.node")].filter((f) => !exists(path.join(DOLT_DIR, f)));
if (doltMissing.length > 0) {
	const msg = `@dolthub/doltlite missing from the standalone: ${doltMissing.join(", ")}`;
	if (DOLT_PLATFORM === "darwin-arm64") {
		console.error(`[build-server] REFUSING: ${msg}`);
		console.error("             Check outputFileTracingIncludes in next.config.ts.");
		process.exit(1);
	}
	console.warn(`[build-server] WARNING (${DOLT_PLATFORM}, not required until D5): ${msg}`);
}
if (exists(DOLT_PREBUILDS)) {
	for (const entry of fs.readdirSync(DOLT_PREBUILDS)) {
		const full = path.join(DOLT_PREBUILDS, entry);
		const isCli = /^doltlite(\.exe)?$/.test(entry);
		const otherPlatform = fs.statSync(full).isDirectory() && entry !== DOLT_PLATFORM;
		const cliInPlatformDir = entry === DOLT_PLATFORM && fs.readdirSync(full).some((f) => /^doltlite(\.exe)?$/.test(f));
		if (isCli || otherPlatform || cliInPlatformDir) {
			console.error(`[build-server] REFUSING: standalone ships doltlite prebuilds/${entry} (${isCli || cliInPlatformDir ? "the doltlite CLI" : "another platform's prebuild"}).`);
			console.error("             Check outputFileTracingIncludes in next.config.ts — no whole-package glob.");
			process.exit(1);
		}
	}
}

console.log("[build-server] server payload ready:", STANDALONE);