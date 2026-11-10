/**
 * The home "Proposed sessions" panel (K5) over seeds.sqlite. It reads stored proposals and writes labels and accepts;
 * it never builds a judge or an LLM, so nothing here reaches a model. A seed starts a chat through POST /api/chats
 * (the client calls it) and is never imported into the graph (K-D1).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { composeAllowEgress, readOptOut } from "../seed/egress.ts";
import { acceptProposal, dismissProposal, panelRows, type AcceptResult, type DismissResult, type PanelRow } from "../seed/panel.ts";
import type { SeedStore } from "../seed/store.ts";
import { MigrationRefusedError, stores, withSeedStore } from "./stores.ts";

export type SeedPanelRow = PanelRow;

/** seeds.sqlite has a newer schema, or the opt-out list exists but cannot be read: refuse rather than guess. */
export class SeedPanelUnavailableError extends Error {}

async function allowEgress() {
	try {
		return composeAllowEgress(await readOptOut(path.join(PATHS.data, "seed-optout.txt"), (f) => readFile(f, "utf8")));
	} catch {
		throw new SeedPanelUnavailableError("seed-optout.txt exists but could not be read");
	}
}

function guarded<T>(fn: (store: SeedStore) => T): T | null {
	try {
		return withSeedStore(fn);
	} catch (error) {
		if (error instanceof MigrationRefusedError) throw new SeedPanelUnavailableError(`seeds.sqlite refused: ${error.message}`);
		throw error;
	}
}

export async function seedPanel(): Promise<SeedPanelRow[]> {
	const allow = await allowEgress();
	return guarded((store) => panelRows(store, allow)) ?? [];
}

export async function acceptSeed(input: { proposalId: string; chatId: string }): Promise<AcceptResult | { kind: "no-chat" }> {
	if (!stores.chatStore.getChat(input.chatId)) return { kind: "no-chat" };
	const allow = await allowEgress();
	return guarded((store) => acceptProposal(store, allow, { ...input, at: new Date().toISOString() })) ?? { kind: "not-found" };
}

export function dismissSeed(input: { proposalId: string; verdict: "know" | "skip" }): DismissResult {
	return guarded((store) => dismissProposal(store, { ...input, at: new Date().toISOString() })) ?? { kind: "not-found" };
}
