/** Prepare source-plugin dependencies for checkout validation, never distribution.
 * Invoke through pnpm or npm so npm_execpath works identically on Windows and Unix. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function runNpm(args, cwd) {
	const execpath = process.env.npm_execpath;
	if (!execpath) throw new Error("Run this helper through pnpm run plugins:setup");
	// Fork: plugin packages carry npm lockfiles outside the pnpm workspace, so run them with npm even when pnpm launched us.
	const result = /pnpm/i.test(path.basename(execpath))
		? spawnSync("npm", args, { cwd, stdio: "inherit", shell: process.platform === "win32" })
		: spawnSync(process.execPath, [execpath, ...args], { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${path.basename(cwd)}: npm ${args.join(" ")} failed (${result.signal ?? result.status})`);
}

export function setupPlugins(root, { run = runNpm } = {}) {
	const source = path.join(root, "plugins");
	const packages = readdirSync(source, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => path.join(source, entry.name))
		.filter(directory => existsSync(path.join(directory, "package.json")))
		.sort()
		.map(directory => {
			if (!existsSync(path.join(directory, "package-lock.json"))) throw new Error(`${path.basename(directory)}: package-lock.json is required for reproducible setup`);
			return { directory, manifest: JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) };
		});
	for (const { directory, manifest } of packages) {
		console.log(`[plugin-setup] ${path.basename(directory)}`);
		if (typeof manifest.scripts?.sdk === "string") run(["run", "sdk"], directory);
		run(["ci"], directory);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { setupPlugins(path.resolve(import.meta.dirname, "..")); }
	catch (error) { console.error("[plugin-setup]", error); process.exitCode = 1; }
}
