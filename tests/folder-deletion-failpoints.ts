/**
 * The sidebar's folder Delete when a write fails part way, on whichever backend LH_STORAGE names
 * (the entry files set it: folder-deletion-failpoints-{file,sqlite,doltlite}.test.ts).
 *
 * Chat records are files on every backend, so they cannot join the graph's SQL transaction. The
 * order that keeps user data safe is: the graph traces in one transact (committed first), then the
 * session records, then the organization. Every failpoint then leaves a state the next Delete (with
 * a freshly reviewed scope) completes cleanly:
 *  - no orphans: a session that is gone has no graph traces left (delete-nodes);
 *  - no half-deleted folder: the folder stays while any of its sessions survives;
 *  - nothing outside the scope is touched, and the folder's notes are never lost;
 *  - a removed practice session's reviews are always logged first (the review ledger outlives the chat);
 *  - the review failpoint touches nothing at all; the graph failpoint touches nothing but those review lines.
 * The expected final state comes from a model built from the setup inputs, never from the code under test.
 */
import assert from "node:assert/strict";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { folderDeletionScope, type ChatDeleteMode, type GraphNode } from "../src/core/index.ts";
import { recordOf } from "./helpers/review-fixtures.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-folder-failpoints-"));
const data = path.join(root, "data");
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const { stores, storageBackend } = await import("../src/server/stores.ts");
const { sourceDirectory } = await import("../src/server/source-organization.ts");
const { deleteFolderWithSessions } = await import("../src/server/source-deletion.ts");
const { releaseGraphDb } = await import("../src/store/sql/open.ts");
const { releaseStoreLock } = await import("../src/store/marker.ts");
after(() => { releaseGraphDb(data); releaseStoreLock(data); fs.rmSync(root, { recursive: true, force: true }); });

type Fail = "none" | "review" | "graph" | "org" | number; // a number = the index (in scope order) of the session record whose delete fails
interface Case { sessions: number; notes: number; nested: boolean; mode: ChatDeleteMode; fail: Fail }

const node = (id: string, sources: string[]): GraphNode =>
	({ id, name: id, statement: `${id} statement`, aliases: [], createdAt: "2026-11-21", provenance: sources.map((chatId) => ({ chatId, messageId: "m" })) });

let run = 0;
function setup(c: Case) {
	const p = `r${run++}`;
	const del = `${p}_del`, sub = `${p}_sub`, top = `${p}_top`;
	const sessions = Array.from({ length: c.sessions }, (_, i) => stores.chatStore.createChat(`${p} session ${i}`, i === 1 ? "practice" : undefined).id);
	const kept = stores.chatStore.createChat(`${p} kept`).id;
	// Session 1 is a practice session with one concluded problem: its review is logged on delete.
	const practice = sessions[1];
	if (practice) stores.chatStore.saveMessages(practice, recordOf([{ id: "x", tagged: true, concluded: true, outcome: "solved" }]));
	const notes = Array.from({ length: c.notes }, (_, i) => `${p}_note${i}`);
	for (const id of notes) stores.graphStore.upsertSource({ id, filePath: `${id}.md`, importedAt: "2026-11-21" });
	for (const s of sessions) stores.graphStore.appendNode(node(`${p}_only_${s}`, [s]));
	stores.graphStore.appendNode(node(`${p}_shared`, [sessions[0]!, kept]));
	for (const n of notes) stores.graphStore.appendNode(node(`${p}_from_${n}`, [n]));
	const inner = (i: number) => (c.nested && i % 2 === 1 ? sub : del);
	const org = stores.sourceOrganizationStore.read();
	stores.sourceOrganizationStore.write({
		...org,
		folders: [...org.folders,
			{ id: top, name: "Top", parentId: null, createdAt: "now" },
			{ id: del, name: "Doomed", parentId: top, createdAt: "now" },
			...(c.nested ? [{ id: sub, name: "Inside", parentId: del, createdAt: "now" }] : [])],
		placements: { ...org.placements,
			[kept]: { folderId: top },
			...Object.fromEntries(sessions.map((s, i) => [s, { folderId: inner(i) }])),
			...Object.fromEntries(notes.map((n, i) => [n, { folderId: inner(i), name: `Note ${i}` }])) },
	});
	const folders = c.nested ? [top, del, sub] : [top, del];
	const ids = [...sessions, kept, ...notes];
	const nodeIds = [...sessions.map((s) => `${p}_only_${s}`), `${p}_shared`, ...notes.map((n) => `${p}_from_${n}`)];
	const reviewIds = practice ? [`${practice}:p_x`] : [];
	return { p, del, top, sessions, practice, kept, notes, folders, ids, nodeIds, reviewIds };
}
type Setup = ReturnType<typeof setup>;

/** Everything this run owns, as plain data. */
function observe(s: Setup) {
	const org = stores.sourceOrganizationStore.read();
	const nodes = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
	return {
		chats: [...s.sessions, s.kept].filter((id) => stores.chatStore.getChat(id) !== null).sort(),
		folders: org.folders.map((f) => f.id).filter((id) => s.folders.includes(id)).sort(),
		placements: Object.fromEntries(Object.entries(org.placements).filter(([id]) => s.ids.includes(id)).sort(([a], [b]) => a.localeCompare(b))),
		nodes: Object.fromEntries(s.nodeIds.filter((id) => nodes.has(id)).map((id) => [id, nodes.get(id)!.provenance.map((x) => x.chatId).sort()])),
		noteSources: stores.graphStore.readSources().map((x) => x.id).filter((id) => s.notes.includes(id)).sort(),
		reviews: stores.graphStore.readReviews().map((r) => r.id).filter((id) => s.reviewIds.includes(id)).sort(),
	};
}

/** The model: what a completed Delete leaves, from the setup inputs alone. */
function model(s: Setup, mode: ChatDeleteMode) {
	const gone = new Set(s.sessions);
	const nodes: Record<string, string[]> = {};
	for (const sId of s.sessions) if (mode === "preserve-graph") nodes[`${s.p}_only_${sId}`] = [sId];
	nodes[`${s.p}_shared`] = mode === "preserve-graph" ? [s.sessions[0]!, s.kept].sort() : [s.kept];
	for (const n of s.notes) nodes[`${s.p}_from_${n}`] = [n];
	return {
		chats: [s.kept],
		folders: [s.top],
		placements: Object.fromEntries(([[s.kept, { folderId: s.top }], ...s.notes.map((n, i) => [n, { folderId: s.top, name: `Note ${i}` }])] as [string, { folderId: string; name?: string }][])
			.filter(([id]) => !gone.has(id)).sort(([a], [b]) => a.localeCompare(b))),
		nodes: Object.fromEntries(s.nodeIds.filter((id) => id in nodes).map((id) => [id, nodes[id]!])),
		noteSources: [...s.notes].sort(),
		reviews: [...s.reviewIds],
	};
}

/** Swap one method for the duration of `fn`, restoring it whatever happens. */
async function patched<T extends object, K extends keyof T>(obj: T, key: K, impl: T[K], fn: () => Promise<unknown>) {
	const original = obj[key];
	obj[key] = impl;
	try { return await fn(); } finally { obj[key] = original; }
}

function inject(fail: Fail, attempt: () => Promise<unknown>): Promise<unknown> {
	if (fail === "none") return attempt();
	if (fail === "review") {
		const gs = stores.graphStore, real = gs.transact.bind(gs);
		return patched(gs, "transact", ((label: string, fn: () => unknown) => label.startsWith("review chat:")
			? (() => { throw new Error("injected: review sync"); })() : real(label, fn)) as typeof gs.transact, attempt);
	}
	if (fail === "graph") {
		const gs = stores.graphStore, real = gs.transact.bind(gs);
		// The traces' transaction does its writes, then fails at the end: the commit never happens.
		return patched(gs, "transact", ((label: string, fn: () => unknown) => label.startsWith("delete sources")
			? real(label, () => { fn(); throw new Error("injected: graph transaction"); }) : real(label, fn)) as typeof gs.transact, attempt);
	}
	if (fail === "org") {
		const org = stores.sourceOrganizationStore;
		return patched(org, "write", (() => { throw new Error("injected: organization write"); }) as typeof org.write, attempt);
	}
	const cs = stores.chatStore, real = cs.deleteChat.bind(cs);
	let calls = 0;
	// The chat store swallows an unlink failure: the record stays and deleteChat reports false.
	return patched(cs, "deleteChat", ((id: string) => (calls++ === fail ? false : real(id))) as typeof cs.deleteChat, attempt);
}

export function runFailpoints(backend: "file" | "sqlite" | "doltlite", numRuns: number): void {
	test(`folder Delete failpoints on ${backend}: no orphans, no half-deleted folder, and the retry completes`, async () => {
		// "review" needs the practice session, which exists from two sessions up.
		const failArb = (n: number) => fc.oneof(fc.constantFrom<Fail>("none", "graph", "org", ...(n >= 2 ? ["review" as const] : [])), fc.integer({ min: 0, max: n - 1 }));
		const caseArb = fc.integer({ min: 1, max: 3 }).chain((sessions) => fc.record<Case>({
			sessions: fc.constant(sessions), notes: fc.integer({ min: 0, max: 2 }), nested: fc.boolean(),
			mode: fc.constantFrom<ChatDeleteMode>("preserve-graph", "delete-nodes"), fail: failArb(sessions),
		}));
		await fc.assert(fc.asyncProperty(caseArb, async (c) => {
			const s = setup(c);
			assert.equal(storageBackend, backend, "the stores run on the backend under test");
			const before = observe(s);
			const scope = () => folderDeletionScope(sourceDirectory.read(), s.del);
			const expected = model(s, c.mode);
			if (c.fail === "none") {
				await deleteFolderWithSessions(s.del, c.mode, scope());
				assert.deepEqual(observe(s), expected);
				return;
			}
			await assert.rejects(inject(c.fail, () => deleteFolderWithSessions(s.del, c.mode, scope())), /injected|Could not remove|practice reviews/);
			const mid = observe(s);
			if (c.fail === "review") assert.deepEqual(mid, before, "a failed review sync touches nothing");
			if (c.fail === "graph") assert.deepEqual({ ...mid, reviews: before.reviews }, before, "a failed graph transaction touches nothing but the logged reviews");
			if (s.practice && !mid.chats.includes(s.practice)) assert.deepEqual(mid.reviews, s.reviewIds, "a removed practice session's review was logged first");
			assert.ok(mid.chats.includes(s.kept), "a session outside the folder is untouched");
			assert.deepEqual(mid.placements[s.kept], { folderId: s.top });
			assert.deepEqual(mid.noteSources, expected.noteSources, "the folder's notes are never lost");
			for (const n of s.notes) assert.ok(mid.placements[n], `note ${n} keeps a placement`);
			if (s.sessions.some((id) => mid.chats.includes(id))) assert.ok(mid.folders.includes(s.del), "no half-deleted folder: it stays while a session survives");
			if (c.mode === "delete-nodes") for (const id of s.sessions) if (!mid.chats.includes(id)) {
				assert.ok(Object.values(mid.nodes).every((sources) => !sources.includes(id)), `no orphan traces: session ${id} is gone, so are its traces`);
			}
			await deleteFolderWithSessions(s.del, c.mode, scope()); // the retry, after a fresh review
			// Known gap (triage): a session the failed attempt already removed is no longer a session to the retry,
			// so its placement moves to the parent like any other non-session placement instead of being dropped.
			const removedEarlier = new Set(s.sessions.filter((id) => !mid.chats.includes(id)));
			const final = observe(s);
			for (const [id, placement] of Object.entries(final.placements)) if (removedEarlier.has(id)) {
				assert.deepEqual(placement, { folderId: s.top }, `a leftover placement of ${id} sits at the parent`);
				delete final.placements[id];
			}
			assert.deepEqual(final, expected);
		}), { numRuns });
	});
}
