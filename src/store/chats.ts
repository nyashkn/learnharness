/**
 * ChatStore — the fs JSON adapter (one file per chat in data/chats/).
 *
 * Implements core/ports.ts ChatStore; the record shapes live in
 * core/contracts.ts (ChatRecord/ChatSummary). Idioms: sync fs, tiny
 * records, id-guarded filenames, JSON with tab indentation. Wired in the
 * composition root (src/server/stores.ts); nothing else constructs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, ImageSnapshot, PlanTree, SideChatThread, TurnUsage } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";
import { beforeWrite, holdsStoreLock } from "./marker.ts";
import { createBlobStore, type BlobStore } from "./cas/blob-store.ts";

/** On disk an image snapshot is `{ mimeType, width, height }`; its bytes live in blobs.sqlite under the key. A legacy record still holds inline `data`. */
type StoredSnapshot = Omit<ImageSnapshot, "data"> & { data?: string };
type StoredChat = Omit<ChatRecord, "imageSnapshots"> & { imageSnapshots?: Record<string, StoredSnapshot> };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A file ChatStore over `chatsDir` (one JSON file per chat). `dataDir` (default: the parent) holds the marker and lock. */
export function createChatStore(chatsDir: string, opts: { dataDir?: string; blobs?: BlobStore } = {}): ChatStore {
	const dataDir = opts.dataDir ?? path.dirname(path.resolve(chatsDir));
	const blobs = opts.blobs ?? createBlobStore(path.join(dataDir, "blobs.sqlite")); // opens per call, so building the store touches no disk
	function chatFile(id: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
		return path.join(/* turbopackIgnore: true */ chatsDir, `${id}.json`);
	}

	/** THE SILENCE LAW (push S6, 2026-10-02): chats-changed announces ONLY
	 *  list-SHAPE mutations — createChat, renameChat, deleteChat (below,
	 *  each emits post-write). The content writers (saveMessages,
	 *  appendTurnUsage, appendExtractionUsage, saveSettings, saveTree) are
	 *  DELIBERATELY SILENT: saveMessages fires per turn-persist and would
	 *  spam the bus, and every list-visible change it causes (title, order,
	 *  phase, busy, pendingQuestion) is already announced by turn-started /
	 *  turn-settled, which the sidebar refetches on. Silence here is law,
	 *  not oversight. */
	function createChat(title: string, kind?: "practice"): ChatRecord {
		const now = new Date().toISOString();
		const record: ChatRecord = {
			id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
			title: title.trim() || "Untitled session",
			createdAt: now,
			updatedAt: now,
			messages: [],
			// Practice sessions carry the marker; teach stays ABSENT (absence
			// reads as teach — pre-practice records never migrate).
			...(kind === "practice" ? { kind: "practice" as const } : {}),
		};
		writeChat(record);
		emit("chats-changed", {});
		return { ...record, version: CURRENT_CHAT_VERSION }; // the in-memory twin of what landed on disk
	}

	/** THE WRITE CHOKE POINT (schema-versioning wave, owner 2026-10-10): every
	 *  record persist goes through here and carries the CURRENT version stamp —
	 *  lazy migration means existing files only get stamped on their next write.
	 *  A future-version guard lives on the read side (getChat). */
	function writeChat(record: StoredChat): void {
		beforeWrite(dataDir); // marker + store lock on the first write
		fs.mkdirSync(chatsDir, { recursive: true });
		// Lazy move: inline bytes whose hash equals their key go to the CAS (committed) BEFORE the JSON that drops them is written.
		// An inline entry whose hash does not match its key stays inline, untouched (no data loss).
		let imageSnapshots = record.imageSnapshots;
		if (imageSnapshots) {
			imageSnapshots = Object.fromEntries(
				Object.entries(imageSnapshots).map(([hash, { data, ...rest }]) => {
					if (data === undefined) return [hash, rest];
					const bytes = Buffer.from(data, "base64");
					if (sha256(bytes) !== hash) return [hash, { ...rest, data }];
					blobs.put(bytes);
					return [hash, rest];
				}),
			);
		}
		writeFileAtomicSync(chatFile(record.id), JSON.stringify({ ...record, ...(imageSnapshots ? { imageSnapshots } : {}), version: CURRENT_CHAT_VERSION }, null, "\t"), { allowInPlaceFallback: true });
	}

	/** The record as stored (no image bytes loaded). Every read-modify-write path and listChats use this. */
	function readRaw(id: string): StoredChat | null {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ chatFile(id), "utf-8"));
		} catch {
			return null;
		}
		// Honest refusal (owner ruling 2026-10-10): a record stamped NEWER than
		// this build (the downgrade scenario) reads as absent, never misparsed —
		// the next read-modify-write must not rewrite what it doesn't understand.
		const v = (parsed as { version?: unknown }).version;
		if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
			console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
			return null;
		}
		return parsed as StoredChat;
	}

	/** Fill each by-hash snapshot's `data` from the CAS. Bytes gone: the entry is dropped (the image route then 404s). Legacy inline entries pass through. */
	function hydrate(record: StoredChat): ChatRecord {
		if (!record.imageSnapshots) return record as ChatRecord;
		const imageSnapshots: Record<string, ImageSnapshot> = {};
		for (const [hash, snap] of Object.entries(record.imageSnapshots)) {
			if (snap.data !== undefined) {
				imageSnapshots[hash] = snap as ImageSnapshot;
				continue;
			}
			const blob = blobs.get(hash);
			if (!blob) {
				console.error(`[chat ${record.id}] image snapshot ${hash} has no bytes in blobs.sqlite — omitted`);
				continue;
			}
			imageSnapshots[hash] = { ...snap, data: Buffer.from(blob.bytes).toString("base64") };
		}
		return { ...record, imageSnapshots };
	}

	// shortcut: getChat hydrates every snapshot, upgrade: a per-snapshot port method when chats get many images.
	function getChat(id: string): ChatRecord | null {
		const record = readRaw(id);
		return record && hydrate(record);
	}

	function listChats(): ChatSummary[] {
		try {
			return fs
				.readdirSync(/* turbopackIgnore: true */ chatsDir)
				.filter((f) => f.endsWith(".json"))
				.map((f) => readRaw(f.slice(0, -5)))
				.filter((r): r is StoredChat => r !== null)
				.map(({ messages, tree, turns, extractions, imageSnapshots: _imageSnapshots, sideChats: _sideChats, ...summary }) => {
					// Per-record isolation (Wave B): a record whose messages fail the
					// projection (e.g. pre-Wave-B UIMessage-format scratch — the
					// zero-back-compat wipe makes these "corrupt") must not blank the
					// whole sidebar — same isolation getChat's per-file catch gives.
					try {
						return {
							// turns and extractions stay out of the list payload (list =
							// summaries; usage aggregates ride the full record, the picker
							// never needs them).
							...summary,
							// Normalized kind: absent record field reads as teach.
							kind: summary.kind ?? "teach",
							messageCount: messages.length,
							// Record-derived status for the session picker: phase from the
							// transcript's explicit events (probe_done concluded / verdict
							// accepted — docs/archive/probe-teach-split.md §4), pending question
							// from the native dangling-call scan. Wave D: both folds read
							// the NATIVE record (core/phases.ts phaseAt3Lh +
							// native-messages.ts danglingQuestionOf). Liveness (busy) is
							// NOT record-derived — the API route merges it (ChatListItem).
							phase: phaseAt3Lh(messages),
							pendingQuestion: danglingQuestionOf(messages) !== null,
							// Practice: a posed problem with no conclude (the sidebar's
							// "Problem waiting"); false on teaching sessions, which
							// have no problem tool.
							pendingProblem: activeProblemOf(messages) !== null,
						};
					} catch (err) {
						console.error(`[chat ${summary.id}] summary projection failed:`, err);
						return null;
					}
				})
				.filter((s) => s !== null)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		} catch {
			return [];
		}
	}

	/** Persist the full native message list (the record IS the agent state —
	 *  Wave B: replay is state.messages = record.messages). SILENT by the
	 *  events law — see the SILENCE LAW comment at createChat. */
	function saveMessages(id: string, messages: LhMessage[]): void {
		const record = readRaw(id);
		if (!record) throw new Error(`Chat not found: ${id}`);
		// Side-delivery watermarks are part of the appended native entries,
		// so input + updates commit together without mutating thread history.
		record.messages = messages;
		record.updatedAt = new Date().toISOString();
		writeChat(record);
	}

	/** A synchronous read/merge/write keeps concurrent worker and turn writes from losing snapshots. */
	function saveImageSnapshot(id: string, snapshotId: string, image: ImageSnapshot): void {
		const bytes = Buffer.from(image.data, "base64");
		if (!/^[a-f0-9]{64}$/.test(snapshotId) || sha256(bytes) !== snapshotId) {
			throw new Error("Invalid image snapshot identity");
		}
		const record = readRaw(id);
		if (!record) throw new Error(`Chat not found: ${id}`);
		blobs.put(bytes); // bytes first (also heals a by-hash entry whose bytes went missing)
		if (record.imageSnapshots?.[snapshotId]) return;
		record.imageSnapshots = { ...record.imageSnapshots, [snapshotId]: { mimeType: image.mimeType, width: image.width, height: image.height } };
		writeChat(record);
	}

	/** Append one usage entry to the record's turn log — idempotent per
	 * turn id: each REQUEST carries its own id, so a replay of the same turn's
	 * persist appends once, while continuation turns (which share a response
	 *  message id) each keep their usage. */
	function appendTurnUsage(id: string, entry: TurnUsage): void {
		const record = readRaw(id);
		if (!record) throw new Error(`Chat not found: ${id}`);
		record.turns = record.turns?.some((t) => t.id === entry.id)
			? record.turns
			: [...(record.turns ?? []), entry];
		writeChat(record);
	}

	/** Append one extraction-run usage entry to the record's extractions
	 * log — idempotent per startedAt: a retry that reaches the append twice
	 * (abort replays) does not double-count spend. */
	function appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
		const record = readRaw(id);
		if (!record) throw new Error(`Chat not found: ${id}`);
		record.extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
			? record.extractions
			: [...(record.extractions ?? []), entry];
		writeChat(record);
	}

	/** Persist the per-chat model/thinking settings — replace-whole (the
	 * picker sends the complete object; absent = config defaults). */
	function saveSettings(id: string, settings: ChatSettings): void {
		const record = readRaw(id);
		if (!record) throw new Error(`Chat not found: ${id}`);
		// Like saveTree: a settings tweak is not conversation activity, so it
		// deliberately does NOT bump updatedAt (sidebar order must not churn).
		record.settings = settings;
		writeChat(record);
	}

	/** Rename a session (the header's click-to-edit title, 2026-09-17). Like
	 * saveSettings, a rename is NOT conversation activity: updatedAt stays put
	 * so sidebar order never churns. Same fallback as createChat — the empty
	 * string becomes "Untitled session" (the API gate rejects it first; this
	 * is the honest floor for any other caller). */
	function renameChat(id: string, title: string): ChatRecord {
		const record = readRaw(id);
		if (!record) throw new Error(`Chat not found: ${id}`);
		record.title = title.trim() || "Untitled session";
		writeChat(record);
		emit("chats-changed", {});
		return hydrate(record);
	}

	/** Delete the session record file entirely (session-deletion wave 6,
	 *  owner 2026-09-22). False when the id is unknown — the route turns that
	 *  into a 404. The record's graph traces and jobs are the route's
	 *  choreography (core/graph-deletion.ts), not the store's. */
	function deleteChat(id: string): boolean {
		if (fs.existsSync(chatFile(id))) beforeWrite(dataDir); // a real removal is a write; an unknown id is not
		try {
			fs.unlinkSync(chatFile(id));
			removeLeftoverTemps(chatFile(id));
		} catch {
			return false; // never existed, already deleted, or unreadable — same answer
		}
		if (holdsStoreLock(dataDir)) sweepBlobs(); // the sweep is a write: only under the lock
		emit("chats-changed", {}); // only a real removal — the present-entry law
		return true;
	}

	/** Delete CAS rows no chat references (orphans of a crashed save, a deleted chat's images). Synchronous under the store lock beforeWrite took,
	 *  so no save in this process interleaves. Fail closed: any unreadable or newer file means delete nothing. Never throws. */
	function sweepBlobs(): void {
		try {
			const keep = new Set<string>();
			for (const f of fs.readdirSync(chatsDir).filter((f) => f.endsWith(".json"))) {
				const parsed = JSON.parse(fs.readFileSync(path.join(chatsDir, f), "utf-8")) as { version?: unknown; imageSnapshots?: Record<string, unknown> };
				if (typeof parsed.version === "number" && parsed.version > CURRENT_CHAT_VERSION) throw new Error(`${f} is stamped version ${parsed.version}`);
				for (const h of Object.keys(parsed.imageSnapshots ?? {})) keep.add(h);
			}
			blobs.sweep(keep);
		} catch (err) {
			console.error("[chats] blob sweep skipped (nothing deleted):", err);
		}
	}

	/** Persist the session plan tree (plan tools call this in execute). */
	function saveTree(id: string, tree: PlanTree): void {
		const record = readRaw(id);
		if (!record) throw new Error(`Chat not found: ${id}`);
		record.tree = tree;
		// Deliberately does NOT bump updatedAt: tree mutations piggyback on the
		// turn's saveMessages, and sidebar ordering shouldn't churn on tree edits.
		writeChat(record);
	}

	/** Side-question threads (2026-11-02): one synchronous read-modify-write,
	 *  so a concurrent turn's saveMessages (which re-reads the record) never
	 *  loses a thread and a thread write never loses messages. Null when the
	 *  chat is gone (a side answer finishing after session deletion). Silent
	 *  and not conversation activity, like saveSettings. */
	function updateSideChats(id: string, update: (threads: SideChatThread[]) => SideChatThread[]): SideChatThread[] | null {
		const record = readRaw(id);
		if (!record) return null;
		const next = update(record.sideChats ?? []);
		if (next.length > 0) record.sideChats = next;
		else delete record.sideChats;
		writeChat(record);
		return next;
	}

	return {
		createChat,
		getChat,
		listChats,
		saveMessages,
		saveImageSnapshot,
		saveTree,
		saveSettings,
		renameChat,
		deleteChat,
		appendTurnUsage,
		appendExtractionUsage,
		updateSideChats,
	};
}

/** The app's instance, built from config paths. */
export const chatStore: ChatStore = createChatStore(PATHS.chats, { dataDir: PATHS.data });
