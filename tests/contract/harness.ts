/**
 * Adapter-agnostic harness for the storage contract (CB2). An adapter is a file in
 * tests/contract/adapters/*.ts whose default export is an AdapterFactory (or an array of them);
 * there is no central list.
 */
import fc from "fast-check";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ReviewLine, CoverageEntry, GraphChain, GraphNode, ProvenancePoint, SessionCheckpoint } from "../../src/core/contracts.ts";
import type {
	AuthStore, ChatStore, GraphStore, JobStore, PromptOverrideStore,
	SettingsStore, SourceOrganizationStore,
} from "../../src/core/ports.ts";

export type Ledger = "nodes" | "chains" | "coverage" | "checkpoints";
/** Every ledger a corruption hook can reach: the four rewritable ones plus the review ledger (never rewritten). */
export type AnyLedger = Ledger | "reviews" | "reviewRemaps";

export interface StoreBundle {
	graph: GraphStore;
	chats: ChatStore;
	jobs: JobStore;
	settings: SettingsStore;
	sourceOrg: SourceOrganizationStore;
	prompts: PromptOverrideStore;
	auth: AuthStore;
	/** Render settings have no port today (spec: new RenderSettingsStore). */
	render: { read(): unknown | null; write(raw: unknown): unknown };
	/** The adapter's own event bus (items 4 and 10): the stores emit through the module instance the adapter loaded. */
	events: { subscribe(listener: (event: { type: string }) => void): () => void };
	hooks: {
		/** Put an unreadable-shaped record line into a ledger (appended, newline-terminated). */
		injectCorruptLine(ledger: AnyLedger, text: string): void;
		/** Simulate a torn append (no terminating newline). Omit if the back-end cannot tear. */
		injectTornTail?(ledger: AnyLedger, text: string): void;
		/** Make the data folder claim a NEWER graph format than this build knows. */
		stampNewerFormat(): void;
		/** Undo stampNewerFormat. */
		clearFormatStamp(): void;
		/** Versioned back-ends only (capabilities.commits): the commit messages of the store, newest first, read through a separate read-only connection. [] before the store exists. */
		commitMessages?(): string[];
	};
	/** Release handles. The harness removes the folder. */
	dispose(): void;
}

export interface AdapterFactory {
	name: string;
	/** Self-declared, then checked against the opened bundle (a wrong `false` would silently skip properties). */
	capabilities: { revision: boolean; corruptLines: boolean; refusesAtOpen: boolean; /** A versioned back-end: bundles expose hooks.commitMessages. */ commits: boolean };
	/** Per-property time limit when the engine fsyncs every commit (DoltLite); default PROPERTY_TIMEOUT_MS. Run counts are NOT changed. */
	propertyTimeoutMs?: number;
	/** Open a FRESH, EMPTY store whose bytes live under `dir` (an existing empty folder the harness owns and removes). */
	open(dir: string): Promise<StoreBundle>;
}

/** Glob tests/contract/adapters/*.ts. Fails loudly when the glob is empty (an empty glob would pass vacuously). */
export async function discoverAdapters(): Promise<AdapterFactory[]> {
	const here = path.dirname(new URL(import.meta.url).pathname);
	const contracts = fs.readdirSync(here).filter((f) => f.endsWith(".contract.ts"));
	const files = fs.readdirSync(path.join(here, "adapters")).filter((f) => f.endsWith(".ts")).sort();
	if (contracts.length === 0 || files.length === 0) throw new Error(`contract discovery found ${contracts.length} contract files and ${files.length} adapters in ${here}`);
	const out: AdapterFactory[] = [];
	for (const f of files) {
		const m = (await import(`./adapters/${f}`)) as { default: AdapterFactory | AdapterFactory[] };
		out.push(...[m.default].flat());
	}
	return out;
}

/** Open the folder `b` was opened on again (after a hook changed it); returns the new bundle or rejects. Tracks dir by openFresh. */
const dirs = new WeakMap<StoreBundle, string>();
export async function reopen(f: AdapterFactory, b: StoreBundle): Promise<StoreBundle> {
	const dir = dirs.get(b);
	if (!dir) throw new Error("reopen: bundle was not opened by openFresh");
	return f.open(dir);
}

/** A fresh temp folder, an open store in it, and a dispose that also removes the folder. */
export async function openFresh(f: AdapterFactory): Promise<StoreBundle> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lh-contract-${f.name}-`));
	const b = await f.open(dir);
	const wrapped: StoreBundle = { ...b, dispose: () => { try { b.dispose(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } } };
	dirs.set(wrapped, dir);
	return wrapped;
}

// ── generators ──
/** Generators. Small pools on purpose: collisions (repeated ids, repeated
 *  aliases, repeated provenance points) are where fold bugs live. */

export const nodeId = fc.constantFrom("n1", "n2", "n3", "n4", "n5");
export const chainId = fc.constantFrom("arg_1", "arg_2", "arg_3", "arg_4");
const text = fc.constantFrom("", "s1", "s2", "s3", "a1", "a2", "uni é中", "line\nbreak", 'q"uote');
const stamp = fc.constantFrom("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
export const point: fc.Arbitrary<ProvenancePoint> = fc.record({
	chatId: fc.constantFrom("c1", "c2"),
	messageId: fc.constantFrom("", "m1", "m2"),
});
export const nodeLine: fc.Arbitrary<GraphNode> = fc.record({
	id: nodeId,
	name: text,
	statement: text,
	aliases: fc.array(text, { maxLength: 3 }),
	createdAt: stamp,
	provenance: fc.array(point, { maxLength: 3 }),
});
export const chainLine: fc.Arbitrary<GraphChain> = fc.record({
	id: chainId,
	premises: fc.uniqueArray(nodeId, { minLength: 1, maxLength: 3 }),
	conclusion: nodeId,
	createdAt: stamp,
	provenance: fc.array(point, { maxLength: 3 }),
});
/** Chains as the extractor emits them: premise != conclusion. */
export const sanePremises = (c: GraphChain): GraphChain | null => {
	const premises = c.premises.filter((p) => p !== c.conclusion);
	return premises.length ? { ...c, premises } : null;
};
export const saneChainLine = chainLine.map(sanePremises).filter((c): c is GraphChain => c !== null);
export const coverageLine: fc.Arbitrary<CoverageEntry> = fc.record({
	chatId: fc.constantFrom("c1", "c2"),
	fp: fc.constantFrom("fp1", "fp2", "fp3"),
	tokens: fc.nat(1000),
	foldedAt: stamp,
});
export const checkpointLine: fc.Arbitrary<SessionCheckpoint> = fc.record({
	chatId: fc.constantFrom("c1", "c2", "src_1"),
	foldedAt: stamp,
});
/** Synthetic review lines: id = chatId:problemCallId, so a collision means a duplicate problem. Optional fields vary on purpose. */
export const reviewLine: fc.Arbitrary<ReviewLine> = fc.tuple(
	fc.constantFrom("c1", "c2"), fc.constantFrom("call_1", "call_2", "call_3"), stamp,
	fc.uniqueArray(nodeId, { minLength: 1, maxLength: 3 }),
	fc.constantFrom("solved", "solvedWithHints", "movedOn", "surrendered", "dismissed" as const),
	fc.constantFrom("R0", "R1", "R5", null),
	fc.record({
		mode: fc.constantFrom("recall", "discrimination", "composition"),
		missClass: fc.constantFrom("cue", "careless", null),
		surface: fc.constantFrom("s1", "uni é中"),
		confidence: fc.oneof(fc.integer({ min: 0, max: 100 }), fc.double({ min: 0, max: 100, noNaN: true })),
	}, { requiredKeys: [] }),
).map(([chatId, problemCallId, at, targets, outcome, rung, opt]) => ({ id: `${chatId}:${problemCallId}`, chatId, problemCallId, at, targets, outcome, rung, ...opt }) as ReviewLine);
/** Valid-JSON-or-not lines that every strict reader must skip. */
export const garbage = fc.constantFrom("{", "not json", "{\"id\":1}", "[]", "null", "42", "{\"id\":\"x\"}", "\"str\"", "{\"chatId\":1}");

/** Verbatim lines (item 12): unknown fields, edge whitespace and shuffled key order must all survive a round trip untouched. */
const edgeText = fc.constantFrom(" ", "  x ", "\tt\t", " lead", "trail ", "a  b", "uni é中", "line\nbreak", 'q"uote', "");
const extraVal = fc.oneof(fc.string({ maxLength: 4 }), fc.nat(), fc.boolean(), fc.constant(null), fc.array(fc.nat(), { maxLength: 2 }));
const verbatim = <T extends object>(base: fc.Arbitrary<T>): fc.Arbitrary<T> =>
	fc.tuple(base, fc.dictionary(fc.constantFrom("zz", "extra", "aa", "_x", "note"), extraVal), fc.infiniteStream(fc.nat(1000)))
		.map(([rec, extras, rnd]) => {
			const entries = Object.entries({ ...rec, ...extras });
			const it = rnd[Symbol.iterator]();
			const keyed = entries.map((e) => [it.next().value as number, e] as const).sort((a, b) => a[0] - b[0]);
			return Object.fromEntries(keyed.map(([, e]) => e)) as T;
		});
export const verbatimNode: fc.Arbitrary<GraphNode> = verbatim(fc.tuple(nodeLine, edgeText, edgeText).map(([n, name, statement]) => ({ ...n, name, statement })));
export const verbatimChain: fc.Arbitrary<GraphChain> = verbatim(chainLine);
export const verbatimCoverage: fc.Arbitrary<CoverageEntry> = verbatim(coverageLine);
export const verbatimReview: fc.Arbitrary<ReviewLine> = verbatim(reviewLine);
export const verbatimCheckpoint: fc.Arbitrary<SessionCheckpoint> = verbatim(checkpointLine);

/** Per-property time limit: a hang while shrinking fails the property instead of stalling the gate. */
export const PROPERTY_TIMEOUT_MS = 90_000;
export const runs = Number(process.env.FC_RUNS ?? 100);
export const seed = Number(process.env.FC_SEED ?? 20261108) // fixed default: reproducible; vary to explore;
export const cfg: fc.Parameters<unknown> = { numRuns: runs, interruptAfterTimeLimit: PROPERTY_TIMEOUT_MS - 20_000, markInterruptAsFailure: true, ...(seed !== undefined ? { seed } : {}) };
