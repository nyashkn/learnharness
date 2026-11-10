import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ProposedSessions, type ProposedSession } from "../components/proposed-sessions.tsx";
import { readOpeningPromptEntry } from "../components/opening-prompt.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });

// linkedom has no sessionStorage: Map-backed shim, reset per test.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", {
	configurable: true,
	value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) },
});

let root: Root | undefined, host: HTMLDivElement | undefined;
const originalFetch = globalThis.fetch;
beforeEach(() => store.clear());
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); globalThis.fetch = originalFetch; });

const row = (over: Partial<ProposedSession> = {}): ProposedSession => ({ id: "s1", title: "Hash maps basics", why: "You used them often.", evidence: ["an invented note"], prerequisiteFor: null, label: "learn", acceptable: true, ...over });

interface Call { method: string; url: string; body: unknown }
/** Stub fetch: records every call; `reply(call)` overrides the default responses. */
function makeFetch(proposals: ProposedSession[] | "fail", reply: (c: Call, n: number) => Response | undefined = () => undefined) {
	const calls: Call[] = [];
	const fetchLike = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call: Call = { method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(init.body as string) : undefined };
		calls.push(call);
		const custom = reply(call, calls.filter((c) => c.method === call.method && c.url === call.url).length);
		if (custom) return custom;
		if (call.method === "GET" && call.url === "/api/seed") return proposals === "fail" ? new Response("x", { status: 500 }) : Response.json({ proposals });
		if (call.url === "/api/chats") return Response.json({ id: "chat_1" });
		if (call.url === "/api/seed") return Response.json({ firstMessage: "Let us talk about hash maps." });
		return new Response("unexpected", { status: 404 });
	}) as typeof fetch;
	return { calls, fetchLike };
}

async function mount(fetchLike: typeof fetch, opts: { canStart?: () => boolean } = {}) {
	const navigated: string[] = [];
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => { root!.render(<ProposedSessions canStart={opts.canStart ?? (() => true)} navigate={(h) => void navigated.push(h)} fetchLike={fetchLike} />); });
	await act(async () => {});
	return navigated;
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function click(id: string) {
	const el = q(id); assert.ok(el, id);
	await act(async () => { el.click(); });
	await act(async () => {});
}
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? null;

it("renders nothing when there are no proposals or the GET fails", async () => {
	await mount(makeFetch([]).fetchLike);
	assert.equal(q("seed-panel"), null);
	await act(async () => { root!.unmount(); }); host!.remove();
	await mount(makeFetch("fail").fetchLike);
	assert.equal(q("seed-panel"), null);
});

it("lists rows after expanding and shows the count in the toggle", async () => {
	await mount(makeFetch([row(), row({ id: "s2", title: "Recursion" })]).fetchLike);
	assert.match(q("seed-panel-toggle")!.textContent!, /2 proposed sessions/);
	assert.equal(document.querySelectorAll('[data-testid="seed-row"]').length, 0);
	await click("seed-panel-toggle");
	assert.equal(document.querySelectorAll('[data-testid="seed-row"]').length, 2);
});

it("start prefills the opening prompt and navigates, never sending or importing", async () => {
	const { calls, fetchLike } = makeFetch([row()]);
	const navigated = await mount(fetchLike);
	await click("seed-panel-toggle"); await click("seed-start");
	assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [
		["GET", "/api/seed", undefined],
		["POST", "/api/chats", { title: "Hash maps basics" }],
		["POST", "/api/seed", { action: "accept", id: "s1", chatId: "chat_1" }],
	]);
	assert.deepEqual(readOpeningPromptEntry("chat_1"), { text: "Let us talk about hash maps.", attempted: true });
	assert.deepEqual(navigated, ["/chat/chat_1"]);
	assert.ok(!calls.some((c) => c.url.includes("/api/graph")));
	assert.ok(!calls.some((c) => c.url !== "/api/seed" && c.url !== "/api/chats"), "no chat message/stream endpoint");
});

it("canStart false: no POST and no navigate", async () => {
	const { calls, fetchLike } = makeFetch([row()]);
	const navigated = await mount(fetchLike, { canStart: () => false });
	await click("seed-panel-toggle"); await click("seed-start");
	assert.deepEqual(calls.filter((c) => c.method === "POST"), []);
	assert.deepEqual(navigated, []);
});

it("acceptable:false disables start and clicking sends nothing", async () => {
	const { calls, fetchLike } = makeFetch([row({ acceptable: false })]);
	const navigated = await mount(fetchLike);
	await click("seed-panel-toggle");
	assert.ok(q("seed-start")!.hasAttribute("disabled"));
	await click("seed-start");
	assert.deepEqual(calls.filter((c) => c.method === "POST"), []);
	assert.deepEqual(navigated, []);
});

it("retry after an accept failure reuses the created chat", async () => {
	const { calls, fetchLike } = makeFetch([row()], (c, n) => (c.url === "/api/seed" && c.method === "POST" && n === 1 ? new Response("no", { status: 500 }) : undefined));
	const navigated = await mount(fetchLike);
	await click("seed-panel-toggle"); await click("seed-start");
	assert.ok(alertText());
	assert.deepEqual(navigated, []);
	await click("seed-start");
	assert.equal(calls.filter((c) => c.url === "/api/chats").length, 1, "no second chat created");
	const accepts = calls.filter((c) => c.url === "/api/seed" && c.method === "POST");
	assert.equal(accepts.length, 2);
	assert.deepEqual(accepts[1]!.body, { action: "accept", id: "s1", chatId: "chat_1" });
	assert.deepEqual(navigated, ["/chat/chat_1"]);
});

for (const [testid, verdict] of [["seed-know", "know"], ["seed-skip", "skip"]] as const) {
	it(`dismiss ${verdict} posts the verdict and removes the row`, async () => {
		const { calls, fetchLike } = makeFetch([row(), row({ id: "s2", title: "Recursion" })]);
		await mount(fetchLike);
		await click("seed-panel-toggle"); await click(testid);
		assert.deepEqual(calls.at(-1)!.body, { action: "dismiss", id: "s1", verdict });
		assert.equal(document.querySelectorAll('[data-testid="seed-row"]').length, 1);
	});
}

it("dismiss failure keeps the row and shows an alert", async () => {
	const { fetchLike } = makeFetch([row()], (c) => (c.method === "POST" && c.url === "/api/seed" ? new Response("no", { status: 500 }) : undefined));
	await mount(fetchLike);
	await click("seed-panel-toggle"); await click("seed-know");
	assert.equal(document.querySelectorAll('[data-testid="seed-row"]').length, 1);
	assert.ok(alertText());
});
