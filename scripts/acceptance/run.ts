/** `just acceptance`: drives the fork's screens headless (puppeteer-core + `next dev`) on a throwaway data folder and a scripted model.
 *  One PASS/FAIL line per step, one screenshot per step; exit 0 only when every step passed. Never the real data folder, never real keys. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "puppeteer-core";
import { api, configureScripted, launchBrowser, lh, newFolder, newRun, openPage, shot, startServer, type Run, type Server } from "./harness.ts";
import { NODES, readSeedDecisions, seedGraph, seedProposals } from "./seed.ts";
import { startScriptedModel, type ScriptState } from "./scripted-model.ts";

const run = newRun();
const state: ScriptState = { target: NODES[0].id, requests: 0 };
const results: { name: string; ok: boolean }[] = [];
let current: Page | undefined;
let currentServer: Server | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function step(name: string, fn: () => Promise<void>): Promise<void> {
	try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
	catch (error) {
		results.push({ name, ok: false });
		const reason = (error instanceof Error ? error.message : String(error)).split("\n").slice(0, 3).join(" | ").slice(0, 400);
		const at = error instanceof Error ? /acceptance\/run\.ts:(\d+)/.exec(error.stack ?? "")?.[1] : undefined;
		console.log(`FAIL ${name}: ${reason}${at ? ` (run.ts:${at})` : ""}`);
		if (process.env.LH_ACCEPTANCE_DEBUG && currentServer) console.log(currentServer.logs().split("\n").filter((l) => /POST|PUT|DELETE|rror|warn/.test(l)).slice(-25).join("\n"));
		if (process.env.LH_ACCEPTANCE_DEBUG && current && !current.isClosed()) console.log(await current.evaluate(() => [...document.querySelectorAll('[data-testid="question-dock"] button')].map((b) => `${b.textContent?.slice(0, 20)}|disabled=${(b as HTMLButtonElement).disabled}|type=${(b as HTMLButtonElement).type}`).join("\n") + "\n" + document.body.innerText.slice(0, 300)).catch(() => ""));
		if (current && !current.isClosed()) await shot(current, run, `FAIL-${name}`).catch(() => {});
	}
}

/** Start a server on a folder, run `body` with a page on it, always stop the server and close the page. */
async function withApp<T>(f: ReturnType<typeof newFolder>, storage: string | undefined, model: string | null, body: (app: { server: Server; page: Page }) => Promise<T>): Promise<T> {
	const server = await startServer(run, f, storage);
	currentServer = server;
	try {
		const page = await openPage(run.browser!, server.origin + "/");
		current = page;
		if (process.env.LH_ACCEPTANCE_DEBUG) { page.on("console", (m) => console.log(`[console ${m.type()}] ${m.text().slice(0, 200)}`)); page.on("response", (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.request().method()} ${r.url()}`); }); page.on("requestfailed", (r) => console.log(`[reqfail] ${r.url()}`)); page.on("pageerror", (e) => console.log(`[pageerror] ${String(e).slice(0, 200)}`)); }
		await hydrated(page);
		if (model) { await configureScripted(page, model); await page.reload({ waitUntil: "domcontentloaded" }); await hydrated(page); }
		try { return await body({ server, page }); } catch (error) { await shot(page, run, `FAIL-${path.basename(f.home)}`).catch(() => {}); throw error; } finally { await page.close().catch(() => {}); }
	} finally { await server.stop(); }
}

/** Server HTML paints the composer and sidebar before React attaches the composer's native listeners (layout effect), so an input
 *  or click sent then is lost. The sidebar leaves "Loading…" only after a client effect fetched the chat list: React owns the page. */
async function hydrated(page: Page): Promise<void> {
	await page.waitForSelector("[data-file-path-input]");
	await page.waitForFunction(() => !document.body.innerText.includes("Loading…"));
}
async function gotoHome(page: Page): Promise<void> {
	await page.goto(new URL("/", page.url()).href, { waitUntil: "domcontentloaded" });
	await hydrated(page);
}

async function setComposer(page: Page, selector: string, text: string): Promise<void> {
	await page.evaluate((sel, value) => {
		const input = document.querySelector(sel)!;
		input.textContent = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}, selector, text);
}
async function setConfidence(page: Page, value: number): Promise<void> {
	await page.$eval('[data-testid="confidence-slider"]', (el, v) => {
		const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		set.call(el, String(v));
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	}, value);
	await page.waitForFunction((v) => document.querySelector('[data-testid="confidence-slider"]')?.getAttribute("aria-valuetext") === `${v} percent`, {}, value);
}
const marker = (dataDir: string): string | null => {
	try { return JSON.parse(fs.readFileSync(path.join(dataDir, "storage.json"), "utf8")).backend; } catch { return null; }
};
const chatIdOf = (page: Page) => new URL(page.url()).pathname.split("/").pop()!;

function groupFailed(name: string) {
	return (error: unknown) => { console.log(`FAIL ${name}: ${String(error).split("\n")[0]!.slice(0, 300)}`); results.push({ name, ok: false }); };
}
/** What the screens read, with ids and counts only (revisions and timestamps are volatile). */
async function snapshot(page: Page) {
	const graph = (await api(page, "GET", "/api/graph")).json;
	const chats = (await api(page, "GET", "/api/chats")).json.chats;
	const review = (await api(page, "GET", "/api/review")).json;
	const seed = (await api(page, "GET", "/api/seed")).json.proposals;
	return {
		nodes: graph.nodes.map((n: { id: string; name: string }) => `${n.id}:${n.name}`).sort(),
		chats: chats.map((c: { id: string; title: string; messageCount: number }) => `${c.id}:${c.title}:${c.messageCount}`).sort(),
		review: { due: review.dueCount, fresh: review.newCount, picks: review.picks.map((p: { id: string }) => p.id).sort() },
		seed: seed.map((p: { id: string; title: string }) => `${p.id}:${p.title}`).sort(),
	};
}
/** Wait until the home screen has loaded (sessions in the sidebar, review pill, model picker filled); return what the DOM shows. */
async function loadedState(page: Page): Promise<{ pill: string; titles: string[] }> {
	await gotoHome(page);
	await page.waitForFunction(async () => {
		const chats: { title: string }[] = (await (await fetch("/api/chats")).json()).chats;
		const text = document.body.innerText;
		return chats.length > 0 && document.querySelector('[data-testid="review-pill"]') && text.includes("scripted") && chats.every((c) => text.includes(c.title));
	});
	return page.evaluate(async () => {
		const chats: { title: string }[] = (await (await fetch("/api/chats")).json()).chats;
		return { pill: document.querySelector('[data-testid="review-pill"]')!.textContent ?? "", titles: chats.map((c) => c.title).filter((t) => document.body.innerText.includes(t)).sort() };
	});
}
async function assertScreens(page: Page, nodes: number, due: number): Promise<void> {
	assert.equal((await api(page, "GET", "/api/graph")).json.nodes.length, nodes);
	assert.equal((await api(page, "GET", "/api/review")).json.dueCount, due);
	await gotoHome(page);
	await page.waitForSelector('[data-testid="review-pill"]');
}

/** Answer the open quiz: pick Mercury, set confidence, submit. */
async function answerQuiz(page: Page, confidence: number, shotName?: string): Promise<void> {
	await page.waitForSelector('[data-testid="question-dock"]');
	await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="question-dock"] [role="radio"]')].find((el) => el.textContent?.includes("Mercury"))!.click());
	await page.waitForSelector('[data-testid="question-dock"] [role="radio"][aria-checked="true"]');
	await setConfidence(page, confidence);
	await page.waitForFunction(() => { const b = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="question-dock"] button')].find((x) => x.textContent?.includes("Submit answer")); return b && !b.disabled; });
	if (shotName) await shot(page, run, shotName);
	await setComposer(page, '[data-testid="thinking-field"] [data-file-path-input]', "Mercury orbits closest");
	await page.focus('[data-testid="thinking-field"] [role="textbox"]');
	await page.keyboard.press("Enter");
	await page.waitForSelector('[data-testid="answered-card"]');
}
/** Wait until the chat has no turn in flight. */
const settled = (page: Page, id: string) => page.waitForFunction(async (chat) => !(await (await fetch(`/api/chats/${chat}`)).json()).turnInFlight, {}, id);

async function startSession(page: Page, prompt: string): Promise<string> {
	await gotoHome(page);
	await page.waitForFunction(() => !document.querySelector('[data-testid="setup-cta"]'));
	await setComposer(page, "[data-file-path-input]", prompt);
	await page.waitForFunction(() => { const b = document.querySelector<HTMLButtonElement>('button[aria-label="Start session"]'); return b && !b.disabled; });
	await page.locator('button[aria-label="Start session"]').click();
	await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
	return chatIdOf(page);
}

async function main(): Promise<void> {
	const model = await startScriptedModel(state);
	try {
		await launchBrowser(run);

		// ── file backend: seeded only with what the screens cannot make (due reviews, proposals, an imported source); sessions are made through the screens ──
		let fileBefore: (Awaited<ReturnType<typeof snapshot>> & { dom: { pill: string; titles: string[] } }) | undefined;
		const file = newFolder(run, "file");
		await seedGraph(file.dataDir, file.authFile);
		seedProposals(file.dataDir);
		await withApp(file, undefined, model.baseUrl, async ({ page }) => {
			await step("start-file", async () => {
				const graph = await api(page, "GET", "/api/graph");
				assert.equal(graph.status, 200);
				assert.ok(JSON.stringify(graph.json).includes(NODES[0].id), "seeded node missing from /api/graph");
				assert.ok([null, "file"].includes(marker(file.dataDir)), `marker ${marker(file.dataDir)}`);
				await shot(page, run, "01-start-file");
			});
			await step("session-quiz-confidence", async () => {
				const id = await startSession(page, "teach me about planets");
				await answerQuiz(page, 70, "02-quiz-confidence-70");
				await shot(page, run, "03-quiz-answered");
				const record = await api(page, "GET", `/api/chats/${id}`);
				assert.match(JSON.stringify(record.json), /"confidence":\s*70/, "confidence 70 not in the stored chat record");
			});
			await step("review-queue", async () => {
				const before = (await api(page, "GET", "/api/review")).json;
				assert.ok(before.dueCount >= 2, `dueCount ${before.dueCount}`);
				await gotoHome(page);
				await page.waitForSelector('[data-testid="review-pill"]');
				const pill = await page.$eval('[data-testid="review-pill"]', (e) => e.textContent);
				assert.match(pill ?? "", /due/);
				await shot(page, run, "04-review-pill");
				await page.click('[data-testid="review-pill"]');
				await page.waitForSelector('[data-testid="practice-dock"]');
				await setComposer(page, '[data-testid="practice-thinking-field"] [data-file-path-input]', "2 + 2 is 4");
				await setConfidence(page, 90);
				await shot(page, run, "05-practice-problem");
				await page.click('[data-testid="practice-send"]');
				await page.waitForSelector('[data-testid="conclude-card"]');
				await shot(page, run, "06-practice-concluded");
				await page.waitForFunction(async (n) => (await (await fetch("/api/review")).json()).dueCount < n, {}, before.dueCount);
			});
			await step("seed-panel", async () => {
				await gotoHome(page);
				await page.waitForSelector('[data-testid="seed-panel-toggle"]');
				await page.click('[data-testid="seed-panel-toggle"]');
				await page.waitForFunction(() => document.querySelectorAll('[data-testid="seed-row"]').length === 2);
				await shot(page, run, "07-seed-panel");
				await page.evaluate(() => (document.querySelectorAll('[data-testid="seed-row"]')[0]!.querySelector('[data-testid="seed-start"]') as HTMLElement).click());
				await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
				await shot(page, run, "08-seed-accepted-session");
				await gotoHome(page);
				await page.waitForSelector('[data-testid="seed-panel-toggle"]');
				await page.click('[data-testid="seed-panel-toggle"]');
				await page.waitForFunction(() => document.querySelectorAll('[data-testid="seed-row"]').length === 1);
				await page.click('[data-testid="seed-know"]');
				await page.waitForFunction(() => document.querySelectorAll('[data-testid="seed-row"]').length === 0);
				await shot(page, run, "09-seed-dismissed");
				const d = readSeedDecisions(file.dataDir);
				assert.deepEqual(d.accepts, ["p_first"]);
				assert.equal(d.labels.p_first, "learn");
				assert.equal(d.labels.p_second, "know");
			});
			// What the screens show now (sessions made on the scripted model, the practice review, the seed decisions), for the migrate step.
			await gotoHome(page);
			await page.waitForFunction(async () => (await (await fetch("/api/chats")).json()).chats.every((c: { busy: boolean }) => !c.busy));
			await sleep(1500);
			fileBefore = { ...(await snapshot(page)), dom: await loadedState(page) };
			await shot(page, run, "17-before-migrate");
		}).catch(groupFailed("file-group"));

		// ── sqlite and doltlite: the app picks the backend itself. LH_STORAGE counts only on an EMPTY folder, so the first write is a session started through the screens ──
		const chooseBackend = async (storage: "sqlite" | "doltlite", f: ReturnType<typeof newFolder>, prompt: string) => {
			await withApp(f, storage, model.baseUrl, async ({ page }) => {
				const id = await startSession(page, prompt);
				await settled(page, id);
				assert.equal((await api(page, "POST", "/api/chats", { title: "Survivor session" })).status, 200);
				assert.equal(marker(f.dataDir), storage, `storage.json says ${marker(f.dataDir)}`);
				assert.ok(fs.existsSync(path.join(f.dataDir, `graph.${storage}`)), `graph.${storage} missing`);
				await shot(page, run, storage === "sqlite" ? "10-start-sqlite" : "11-start-doltlite");
			});
			// Seeded after the app wrote the marker (server stopped): the screens cannot make due reviews or an imported source headlessly.
			await seedGraph(f.dataDir, f.authFile);
		};
		const sqlite = newFolder(run, "sqlite");
		await step("start-sqlite", async () => {
			await chooseBackend("sqlite", sqlite, "Kept session");
			await withApp(sqlite, undefined, null, async ({ page }) => { await assertScreens(page, 3, 2); await shot(page, run, "10b-sqlite-screens"); });
		});

		const dolt = newFolder(run, "doltlite");
		let doltReady = false;
		await step("start-doltlite", async () => {
			await chooseBackend("doltlite", dolt, "Kept session");
			doltReady = true;
		});
		if (doltReady) await withApp(dolt, undefined, model.baseUrl, async ({ page }) => {
			await assertScreens(page, 3, 2);
			await shot(page, run, "11b-doltlite-screens");
			await step("delete-source-doltlite", async () => {
				await gotoHome(page);
				await page.locator("::-p-text(Chains)").click();
				await page.locator('input[aria-label="Select source notes"]').click();
				await page.click('[data-testid="chain-delete"]');
				await page.waitForSelector('[data-testid="source-deletion-history"]');
				const words = await page.$eval('[data-testid="source-deletion-history"]', (e) => e.textContent);
				assert.match(words ?? "", /version history until you purge history/);
				await shot(page, run, "12-delete-source-history-wording");
				await page.click('[data-testid="source-delete-confirm"]');
				await page.waitForFunction(() => !document.querySelector('[data-testid="delete-source-dialog"]'));
				const sources = (await api(page, "GET", "/api/graph/sources")).json;
				assert.ok(!sources.sources.some((x: { id: string }) => x.id === "src_notes"), "source still listed");
				assert.equal(sources.keepsHistory, true);
				assert.equal((await api(page, "GET", "/api/graph")).json.nodes.length, 0, "nodes survived their only source");
				await shot(page, run, "13-source-deleted");
			});
			await step("delete-session-doltlite", async () => {
				await gotoHome(page);
				await page.locator('::-p-text(Kept session)').click({ button: "right" });
				await page.locator("::-p-text(Delete…)").click();
				await page.waitForSelector('[data-testid="delete-session-dialog"]');
				await page.click('[data-testid="delete-traces-checkbox"]');
				await shot(page, run, "14-delete-session-dialog");
				await page.click('[data-testid="delete-confirm"]');
				await page.waitForFunction(() => !document.querySelector('[data-testid="delete-session-dialog"]'));
				const titles = (await api(page, "GET", "/api/chats")).json.chats.map((c: { title: string }) => c.title);
				assert.deepEqual(titles, ["Survivor session"]);
				await shot(page, run, "15-session-deleted");
			});
		}).catch(groupFailed("doltlite-group"));
		await step("purge-history-doltlite", async () => {
			const dry = lh(run, dolt.home, ["purge", "--data-dir", dolt.dataDir]);
			assert.equal(dry.status, 2, `dry run exit ${dry.status}: ${dry.out.slice(0, 200)}`);
			const done = lh(run, dolt.home, ["purge", "--data-dir", dolt.dataDir, "--yes"]);
			assert.equal(done.status, 0, `purge exit ${done.status}: ${done.out.slice(0, 300)}`);
			const m = /purged: (\d+) commits -> (\d+)/.exec(done.out);
			assert.ok(m, `no purge line in: ${done.out.slice(0, 300)}`);
			assert.ok(Number(m[1]) > Number(m[2]), `history did not shrink: ${m[0]}`);
			await withApp(dolt, undefined, null, async ({ page }) => {
				const titles = (await api(page, "GET", "/api/chats")).json.chats.map((c: { title: string }) => c.title);
				assert.deepEqual(titles, ["Survivor session"]);
				await shot(page, run, "16-after-purge");
			});
		});

		// ── migrate the file folder the screens just filled (quiz, practice and seed sessions) to doltlite ──
		await step("migrate-file-to-doltlite", async () => {
			const before = fileBefore;
			assert.ok(before, "no snapshot: the file-backend steps did not finish");
			assert.equal(before.nodes.length, 3);
			assert.ok(before.chats.length >= 3, `expected the screens' sessions, got ${before.chats.length}`);
			assert.ok([null, "file"].includes(marker(file.dataDir)));
			const out = lh(run, file.home, ["migrate", "--to", "doltlite", "--data-dir", file.dataDir]);
			assert.equal(out.status, 0, `migrate exit ${out.status}: ${out.out.slice(0, 300)}`);
			assert.equal(marker(file.dataDir), "doltlite");
			const after = await withApp(file, undefined, null, async ({ page }) => {
				const dom = await loadedState(page);
				await shot(page, run, "18-after-migrate");
				return { ...(await snapshot(page)), dom };
			});
			assert.match(before.dom.pill, /due/);
			assert.deepEqual(after, before);
		});
	} finally {
		await run.browser?.close().catch(() => {});
		await model.close();
	}
}

try { await main(); }
catch (error) { console.log(`FAIL acceptance: ${String(error).slice(0, 300)}`); results.push({ name: "acceptance", ok: false }); }
finally {
	await run.browser?.close().catch(() => {});
	for (const pid of run.pids) { try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ } }
	console.log(`screenshots: ${run.shots}`);
	// Throwaway data folders and the browser profile go; the screenshots stay (LH_ACCEPTANCE_KEEP=1 keeps everything).
	if (!process.env.LH_ACCEPTANCE_KEEP) for (const name of fs.readdirSync(run.dir)) if (name !== "shots") try { fs.rmSync(path.join(run.dir, name), { recursive: true, force: true }); } catch { /* a dying child may still write; leftover tmp is not a test result */ }
	process.exit(results.length > 0 && results.every((r) => r.ok) ? 0 : 1);
}
