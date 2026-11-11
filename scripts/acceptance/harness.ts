/** Shared pieces of the acceptance run: a scrubbed `next dev` server, a headless Chrome, and page-side API helpers. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { probeEnv } from "../smoke-demo-runtime.mjs";

export const root = path.resolve(import.meta.dirname, "../..");
const CHROME = process.env.LH_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface Run { dir: string; shots: string; fonts: string; browser?: Browser; pids: number[] }

export function newRun(): Run {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lh-acceptance-${stamp}-`));
	const shots = path.join(dir, "shots");
	fs.mkdirSync(shots);
	// Next's supported font fixture avoids external font downloads (same as scripts/smoke-opening-prompt.mjs).
	const require = createRequire(import.meta.url);
	const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
	const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
	const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map((family) => [
		getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"),
		`@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`,
	]));
	const fontsFile = path.join(dir, "fonts.cjs");
	fs.writeFileSync(fontsFile, `module.exports = ${JSON.stringify(fonts)};\n`);
	return { dir, shots, fonts: fontsFile, pids: [] };
}

/** A fresh empty throwaway data folder (and its auth file) under the run dir. LH_STORAGE only counts on an empty folder. */
export function newFolder(run: Run, name: string): { dataDir: string; authFile: string; home: string } {
	const home = path.join(run.dir, `home-${name}`);
	const dataDir = path.join(home, "data");
	fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
	const authFile = path.join(home, "auth.json");
	fs.writeFileSync(authFile, "{}\n", { mode: 0o600 });
	return { dataDir, authFile, home };
}

export interface Server { origin: string; pid: number; stop: () => Promise<void>; logs: () => string }

export async function startServer(run: Run, f: { dataDir: string; authFile: string; home: string }, storage?: string): Promise<Server> {
	const listener = net.createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const port = (listener.address() as net.AddressInfo).port;
	await new Promise((resolve) => listener.close(resolve));
	const base = probeEnv(process.env, f.home) as Record<string, string | undefined>;
	for (const key of Object.keys(base)) if (key.startsWith("LH_") || key.startsWith("CUSTOM_")) delete base[key];
	const env: NodeJS.ProcessEnv = {
		...base, NODE_ENV: "development", TMPDIR: path.join(f.home, "tmp"), CLAUDE_CONFIG_DIR: path.join(f.home, "claude"),
		LH_DATA_DIR: f.dataDir, LH_AUTH_FILE: f.authFile, LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1",
		NEXT_FONT_GOOGLE_MOCKED_RESPONSES: run.fonts, ...(storage ? { LH_STORAGE: storage } : {}),
	};
	const child: ChildProcess = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
	});
	const pid = child.pid!;
	run.pids.push(pid);
	let logs = "";
	const capture = (d: Buffer) => { logs = (logs + d).slice(-24000); };
	child.stdout!.on("data", capture); child.stderr!.on("data", capture);
	let exited = false;
	child.once("exit", () => { exited = true; });
	const stop = async () => {
		if (exited) return;
		try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
		for (let i = 0; i < 50 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
		if (!exited) try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
		for (let i = 0; i < 30 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
	};
	try {
		await new Promise<void>((resolve, reject) => {
			const deadline = setTimeout(() => reject(new Error("server startup timed out")), 90_000);
			const poll = setInterval(() => { if (logs.includes("Ready in")) { clearTimeout(deadline); clearInterval(poll); resolve(); } }, 200);
			child.once("exit", (code) => { clearTimeout(deadline); clearInterval(poll); reject(new Error(`server exited ${code}: ${logs.slice(-600)}`)); });
		});
	} catch (error) { await stop(); throw error; }
	return { origin: `http://127.0.0.1:${port}`, pid, stop, logs: () => logs };
}

export async function launchBrowser(run: Run): Promise<Browser> {
	run.browser = await puppeteer.launch({
		executablePath: CHROME, headless: true, userDataDir: path.join(run.dir, "chrome"),
		args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--disable-default-apps", "--window-size=1280,900"],
		defaultViewport: { width: 1280, height: 900 },
	});
	return run.browser;
}

export async function openPage(browser: Browser, url: string): Promise<Page> {
	const page = await browser.newPage();
	page.setDefaultTimeout(60_000);
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
	return page;
}

/** Same-origin JSON call from the page (the custom-provider route requires the page's Origin header). */
export async function api(page: Page, method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; etag: string | null }> {
	return page.evaluate(async (m, r, b, h) => {
		const res = await fetch(r, { method: m, headers: { ...(b === undefined ? {} : { "content-type": "application/json" }), ...h }, body: b === undefined ? undefined : JSON.stringify(b) });
		const text = await res.text();
		let json: unknown = null;
		try { json = JSON.parse(text); } catch { json = text; }
		return { status: res.status, json, etag: res.headers.get("etag") };
	}, method, route, body, headers);
}

/** Point the app at the scripted model through the keyless custom provider, and pin all three slots to it. */
export async function configureScripted(page: Page, baseUrl: string): Promise<void> {
	const got = await api(page, "GET", "/api/custom-provider");
	const post = await api(page, "POST", "/api/custom-provider", { baseUrl, authMode: "keyless", manualModels: ["scripted"] }, { "if-match": got.etag ?? "" });
	if (post.status !== 200) throw new Error(`custom-provider POST ${post.status}: ${JSON.stringify(post.json)}`);
	const slot = { model: { provider: "custom", id: "scripted" } };
	const put = await api(page, "PUT", "/api/settings/models", { strong: slot, cheap: slot, vision: slot });
	if (put.status !== 200) throw new Error(`settings/models PUT ${put.status}: ${JSON.stringify(put.json)}`);
	const models = await api(page, "GET", "/api/models");
	const providers = (models.json.providers ?? []).filter((p: { keyPresent: boolean }) => p.keyPresent).map((p: { id: string }) => p.id);
	if (providers.length !== 1 || providers[0] !== "custom") throw new Error(`expected only the scripted provider available, got [${providers.join(",")}]`);
}

export async function shot(page: Page, run: Run, name: string): Promise<void> {
	await page.screenshot({ path: path.join(run.shots, `${name}.png`) });
}

/** `lh <args>` through the repo's CLI with the throwaway env; returns status and combined output (never the environment). */
export function lh(run: Run, home: string, args: string[]): { status: number | null; out: string } {
	const env = { ...(probeEnv(process.env, home) as NodeJS.ProcessEnv), NODE_ENV: "production" } as NodeJS.ProcessEnv;
	for (const key of Object.keys(env)) if (key.startsWith("LH_")) delete env[key];
	const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/lh-storage.ts", ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
