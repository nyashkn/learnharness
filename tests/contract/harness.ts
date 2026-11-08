/**
 * Adapter-agnostic harness for the storage contract (CB2). An adapter is a file in
 * tests/contract/adapters/*.ts whose default export is an AdapterFactory (or an array of them);
 * there is no central list.
 */
import fc from "fast-check";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoverageEntry, GraphChain, GraphNode, ProvenancePoint, SessionCheckpoint } from "../../src/core/contracts.ts";
import type {
	AuthStore, ChatStore, GraphStore, JobStore, PromptOverrideStore,
	SettingsStore, SourceOrganizationStore,
} from "../../src/core/ports.ts";

export type Ledger = "nodes" | "chains" | "coverage" | "checkpoints";

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
	/** Absent until PR0 adds GraphStore.transact. */
	transact?: <T>(label: string, fn: () => T) => T;
	hooks: {
		/** Put an unreadable-shaped record line into a ledger (appended, newline-terminated). */
		injectCorruptLine(ledger: Ledger, text: string): void;
		/** Simulate a torn append (no terminating newline). Omit if the back-end cannot tear. */
		injectTornTail?(ledger: Ledger, text: string): void;
		/** Make the data folder claim a NEWER graph format than this build knows. */
		stampNewerFormat(): void;
		/** Undo stampNewerFormat. */
		clearFormatStamp(): void;
	};
	/** Release handles. The harness removes the folder. */
	dispose(): void;
}

export interface AdapterFactory {
	name: string;
	capabilities: { transact: boolean };
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

/** A fresh temp folder, an open store in it, and a dispose that also removes the folder. */
export async function openFresh(f: AdapterFactory): Promise<StoreBundle> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lh-contract-${f.name}-`));
	const b = await f.open(dir);
	return { ...b, dispose: () => { try { b.dispose(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } } };
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
/** Valid-JSON-or-not lines that every strict reader must skip. */
export const garbage = fc.constantFrom("{", "not json", "{\"id\":1}", "[]", "null", "42", "{\"id\":\"x\"}", "\"str\"", "{\"chatId\":1}");

export const runs = Number(process.env.FC_RUNS ?? 100);
export const seed = Number(process.env.FC_SEED ?? 20261108) // fixed default: reproducible; vary to explore;
export const cfg: fc.Parameters<unknown> = { numRuns: runs, ...(seed !== undefined ? { seed } : {}) };
