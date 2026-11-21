import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { hasApi, type Api, type Model } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { setModelCatalogOverlay } from "../agent/models.ts";
import { AUTH_PROVIDER_KEYS } from "../core/auth-keys.ts";
import type { ModelCatalogRefreshOutcome } from "../core/contracts/models.ts";
import { MODEL_CATALOG_FILE, writeModelCatalogSnapshot } from "./stores.ts";
import { keyValue } from "./keys.ts";
import { readBoundedJson } from "./custom-provider-body.ts";

const FILE = MODEL_CATALOG_FILE;
const MAX_SHARD_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SHARD_ROWS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

// Only the picker’s builtin API-key chat providers. Existing dynamic/connected
// routes (e.g. Radius, OAuth, Claude Code and user endpoints) are not pi.dev shards.
const keyProviders = new Set(AUTH_PROVIDER_KEYS.map(({ id }) => id));
const builtins = new Map(builtinProviders().flatMap((provider) => {
	const models = provider.getModels();
	return keyProviders.has(provider.id) && !provider.refreshModels && models.length > 0
		? [[provider.id, models] as const] : [];
}));

// TypeBox, not zod (fork rule; ported from upstream's zod schemas with the same bounds). Plain objects keep
// zod's z.object behaviour: unknown keys are allowed by the check, then stripped (`strip`), so a feed cannot
// carry extra fields (headers, routing) into a model. `strict` objects reject unknown keys, as z.strictObject did.
const strict = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 256, pattern: "^[\\w.~:@-]+(?:/[\\w.~:@-]+)*$" });
const rate = Type.Number({ minimum: 0, maximum: 1_000_000 });
const rates = { input: rate, output: rate, cacheRead: rate, cacheWrite: rate };
const tokens = Type.Integer({ exclusiveMinimum: 0, maximum: 100_000_000 });
const thinking = Type.Optional(Type.Union([Type.String({ maxLength: 32, pattern: "^[\\w-]*$" }), Type.Null()]));
const byteLimit = Type.Optional(Type.Integer({ exclusiveMinimum: 0, maximum: 1024 ** 3 }));
const imageDimension = Type.Optional(Type.Integer({ exclusiveMinimum: 0, maximum: 8192 }));
const imageCount = Type.Optional(Type.Integer({ exclusiveMinimum: 0, maximum: 10_000 }));
const cacheSeconds = Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 30 * 24 * 3600 }));
const rowSchema = Type.Object({
	type: Type.Optional(Type.Literal("chat")),
	id,
	name: Type.String(), // trimmed first, then bounded: see checkedRow (zod's .trim().min().max().regex() order)
	api: Type.String(),
	baseUrl: Type.String(),
	reasoning: Type.Boolean(),
	thinkingLevelMap: Type.Optional(Type.Object({ off: thinking, minimal: thinking, low: thinking, medium: thinking, high: thinking, xhigh: thinking, max: thinking })),
	input: Type.Array(Type.Enum(["text", "image"]), { minItems: 1, maxItems: 2 }),
	inputLimits: Type.Optional(Type.Object({
		maxRequestBytes: byteLimit,
		images: Type.Optional(Type.Object({
			maxPerMessage: imageCount, maxPerRequest: imageCount,
			resize: Type.Optional(Type.Object({ maxWidth: imageDimension, maxHeight: imageDimension, maxBytes: byteLimit, jpegQuality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, strict)),
		}, strict)),
	}, strict)),
	promptCache: Type.Optional(Type.Object({ short: cacheSeconds, long: cacheSeconds }, strict)),
	cost: Type.Object({ ...rates, tiers: Type.Optional(Type.Array(Type.Object({ ...rates, inputTokensAbove: tokens }), { maxItems: 8 })) }),
	contextWindow: tokens,
	maxTokens: tokens,
});

// Pi 1.5.2 wire flags, per transport. Unknown behavior fails closed; the
// descriptors below are bounded values, never arbitrary request arguments.
const flag = Type.Optional(Type.Boolean());
const sessionAffinity = Type.Optional(Type.Enum(["openai", "openai-nosession", "openrouter"]));
const cacheKeyMode = Type.Optional(Type.Enum(["auto", "enabled", "disabled"]));
const commonOpenAI = {
	supportsDeveloperRole: flag, supportsMidConvoSystemMessages: flag, supportsStrictMode: flag,
	supportsOpenAIGrammarTools: flag, supportsLongCacheRetention: flag,
	sessionAffinityFormat: sessionAffinity, promptCacheKeyMode: cacheKeyMode,
};
const completionsCompat = Type.Object({
	...commonOpenAI,
	supportsStore: flag, supportsReasoningEffort: flag, supportsUsageInStreaming: flag, supportsFinishReason: flag,
	requiresToolResultName: flag, requiresAssistantAfterToolResult: flag, requiresNonNullAssistantContent: flag,
	requiresToolsWithToolHistory: flag, requiresThinkingAsText: flag, requiresReasoningContentOnAssistantMessages: flag,
	maxTokensField: Type.Optional(Type.Enum(["max_tokens", "max_completion_tokens"])),
	thinkingFormat: Type.Optional(Type.Enum(["openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"])),
	zaiToolStream: flag, supportsThinkingTokenBudget: flag, supportsMidConvoToolAdditions: flag, sendSessionAffinityHeaders: flag,
	thinkingTokenBudgetField: Type.Optional(Type.Enum(["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"])),
	cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
	vllmPriority: Type.Optional(Type.Integer({ minimum: -1000, maximum: 1000 })),
}, strict);
const responsesCompat = Type.Object({
	...commonOpenAI,
	supportsAdditionalTools: flag, supportsToolSearch: flag, supportsExplicitPromptCacheMode: flag,
	supportsMidConvoEffort: flag, supportsMaxOutputTokens: flag,
	// Present in bundled data for xAI, even though today's Responses adapter ignores it.
	supportsReasoningEffort: flag,
}, strict);
const anthropicCompat = Type.Object({
	forceAdaptiveThinking: flag, supportsTemperature: flag, supportsEagerToolInputStreaming: flag, supportsCacheControlOnTools: flag,
	supportsLongCacheRetention: flag, sendSessionAffinityHeaders: flag, sessionAffinityFormat: Type.Optional(Type.Literal("openrouter")),
	allowEmptySignature: flag, supportsStrictTools: flag, supportsMidConvoEffort: flag,
	supportsMidConvoSystemMessages: flag, supportsMidConvoToolChanges: flag, supportsMessageThreads: flag,
}, strict);
const mistralCompat = Type.Object({ supportsMidConvoSystemMessages: flag }, strict);
const noCompat = Type.Object({}, strict);

/** Keep only the keys a schema declares, recursively (zod's z.object strip). */
function strip(schema: TSchema, value: unknown): unknown {
	const s = schema as { properties?: Record<string, TSchema>; items?: TSchema };
	if (Array.isArray(value) && s.items) return value.map((item) => strip(s.items!, item));
	if (record(value) && s.properties) {
		return Object.fromEntries(Object.entries(s.properties).flatMap(([key, child]) => (key in value ? [[key, strip(child, value[key])]] : [])));
	}
	return value;
}

/** Value.Check at the trust boundary, then the declared keys only. */
function parse<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
	if (!Value.Check(schema, value)) throw new Error(`Invalid pi.dev ${what}`);
	return strip(schema, value) as Static<T>;
}

/** The row checks JSON Schema cannot say: the trimmed name, no dot segments in the id, text input without duplicates. */
function checkedRow(row: unknown) {
	const parsed = parse(rowSchema, row, "model");
	const name = parsed.name.trim();
	if (!name || name.length > 256 || !/^[^\x00-\x1f\x7f]*$/.test(name)) throw new Error("Invalid pi.dev model name");
	if (parsed.id.split("/").some((part) => part === "." || part === "..")) throw new Error("Invalid pi.dev model id");
	if (!parsed.input.includes("text") || new Set(parsed.input).size !== parsed.input.length) throw new Error("Invalid pi.dev model input");
	return { ...parsed, name };
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function catalogRows(body: unknown): unknown[] {
	// Pi 1.5.x accepts an array, a {models:[]} envelope, or an id map.
	const rows = Array.isArray(body) ? body : record(body) ? ("models" in body ? body.models : Object.values(body)) : null;
	if (!Array.isArray(rows) || rows.length > MAX_SHARD_ROWS || !rows.every((row) => record(row) && typeof row.id === "string")) {
		throw new Error("Invalid pi.dev catalog");
	}
	return rows;
}

function checkedCompat(api: Api, baselines: readonly Model<Api>[], raw: unknown): Model<Api>["compat"] {
	if (raw === undefined) return undefined;
	if (!record(raw)) throw new Error("Invalid pi.dev model compatibility");
	// Ignore feed-controlled routing/fallback choices. If a thinking format
	// needs a template, accept only an exact profile shipped for this route
	// and pass the bundled copy, never arbitrary feed arguments.
	const { openRouterRouting: _or, vercelGatewayRouting: _vg, allowedFallbackModels: _af, chatTemplateArgs, chatTemplateKwargs, ...claims } = raw;
	switch (api) {
		case "openai-completions": {
			const flags = parse(completionsCompat, claims, "model compatibility");
			if (flags.thinkingFormat === "baseten" || flags.thinkingFormat === "chat-template" || chatTemplateArgs !== undefined || chatTemplateKwargs !== undefined) {
				const trusted = baselines.filter((model) => hasApi(model, "openai-completions")).find((model) =>
					model.compat?.thinkingFormat === flags.thinkingFormat
					&& isDeepStrictEqual(model.compat?.chatTemplateArgs, chatTemplateArgs)
					&& isDeepStrictEqual(model.compat?.chatTemplateKwargs, chatTemplateKwargs));
				if (!trusted) throw new Error("Unsupported pi.dev model template");
				return { ...flags, chatTemplateArgs: trusted.compat?.chatTemplateArgs, chatTemplateKwargs: trusted.compat?.chatTemplateKwargs };
			}
			return flags;
		}
		default:
			if (chatTemplateArgs !== undefined || chatTemplateKwargs !== undefined) throw new Error("Unexpected pi.dev model template");
			if (api === "openai-responses") return parse(responsesCompat, claims, "model compatibility");
			if (api === "anthropic-messages") return parse(anthropicCompat, claims, "model compatibility");
			if (api === "mistral-conversations") return parse(mistralCompat, claims, "model compatibility");
			parse(noCompat, claims, "model compatibility");
			return undefined;
	}
}

function checkedModels(provider: string, rows: readonly unknown[]): Model<Api>[] {
	const baseline = builtins.get(provider);
	if (!baseline) return [];
	const known = new Set(baseline.map((model) => model.id));
	const models = new Map<string, Model<Api>>();
	for (const row of rows) {
		if (!record(row) || typeof row.id !== "string") throw new Error("Invalid pi.dev model");
		// Deliberate skips: non-chat kinds, bundled IDs and routes the shipped
		// provider cannot use. An eligible but invalid row fails the refresh.
		if (row.type === "image" || row.type === "classifier" || known.has(row.id)) continue;
		if (typeof row.api !== "string" || !row.api || typeof row.baseUrl !== "string" || !row.baseUrl) throw new Error("Invalid pi.dev model route");
		const routes = baseline.filter((model) => model.api === row.api && model.baseUrl === row.baseUrl);
		const route = routes[0];
		if (!route) continue;
		const { id, api: _api, baseUrl: _baseUrl, ...metadata } = checkedRow(row);
		if ((row.provider !== undefined && row.provider !== provider) || models.has(id) || (route.api === "google-generative-ai" && id.includes(":"))) {
			throw new Error("Invalid pi.dev model identity");
		}
		// Model.samplingParams and its per-level variant allow arbitrary
		// request keys in Pi. Do not silently import models that require them.
		for (const raw of [row.samplingParams, row.samplingParamsByThinkingLevel]) {
			if (raw !== undefined && (!record(raw) || Object.keys(raw).length)) throw new Error("Unsupported pi.dev sampling parameters");
		}
		const compat = checkedCompat(route.api, routes, row.compat);
		models.set(id, {
			...metadata, id, provider, api: route.api, baseUrl: route.baseUrl,
			...(route.headers ? { headers: route.headers } : {}),
			...(compat ? { compat } : {}),
		});
	}
	return [...models.values()];
}

type Catalog = Map<string, readonly Model<Api>[]>;
interface State { snapshot: Catalog; refreshing?: Promise<ModelCatalogRefreshOutcome> }
const STATE_KEY = Symbol.for("lh.remote-model-catalog");
const catalogGlobal = globalThis as typeof globalThis & { [STATE_KEY]?: State };

function restoreSnapshot(): Catalog {
	try {
		if (fs.statSync(FILE).size > MAX_SNAPSHOT_BYTES) return new Map();
		const saved: unknown = JSON.parse(fs.readFileSync(FILE, "utf-8"));
		if (record(saved) && saved.version === 1 && record(saved.providers)) {
			return new Map([...builtins.keys()].flatMap((provider) => {
				const rows = saved.providers as Record<string, unknown>;
				const models = Array.isArray(rows[provider]) ? checkedModels(provider, catalogRows(rows[provider])) : [];
				return models.length ? [[provider, models] as const] : [];
			}));
		}
	} catch { /* Missing/unreadable snapshot: the bundled catalog is still usable. */ }
	return new Map();
}

/** Local file only. Next's server startup restores without checking pi.dev. */
export function initializeModelCatalog(): void {
	if (catalogGlobal[STATE_KEY]) return;
	const snapshot = restoreSnapshot();
	catalogGlobal[STATE_KEY] = { snapshot };
	setModelCatalogOverlay(snapshot);
}

async function fetchShard(provider: string, signal: AbortSignal): Promise<Model<Api>[]> {
	const url = new URL(`https://pi.dev/api/models/providers/${encodeURIComponent(provider)}?types=chat`);
	const response = await fetch(url, {
		cache: "no-store", credentials: "omit", redirect: "error", signal,
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		await response.body?.cancel();
		// These are the SDK's unsupported-shard statuses, not a deletion.
		if (response.status === 404 || response.status === 501) return [];
		throw new Error("pi.dev catalog request failed");
	}
	return checkedModels(provider, catalogRows(await readBoundedJson(response, MAX_SHARD_BYTES)));
}

async function refresh(state: State): Promise<ModelCatalogRefreshOutcome> {
	const configured = AUTH_PROVIDER_KEYS.filter(({ id, envVar }) => builtins.has(id) && keyValue(envVar) !== undefined);
	if (!configured.length) return "no-providers";
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
	try {
		const shards = await Promise.all(configured.map(async ({ id }) => [id, await fetchShard(id, signal)] as const));
		signal.throwIfAborted();
		const snapshot: Catalog = new Map(state.snapshot);
		for (const [provider, models] of shards) {
			if (!models.length) continue;
			// Keep previously imported IDs if a later feed omits them: saved
			// slot, chat and background pins can still refer to them.
			const merged = new Map(snapshot.get(provider)?.map((model) => [model.id, model]));
			for (const model of models) {
				const previous = merged.get(model.id);
				if (!previous || (previous.api === model.api && previous.baseUrl === model.baseUrl)) merged.set(model.id, model);
			}
			if (merged.size > MAX_SHARD_ROWS) throw new Error("Model catalog exceeds the row limit");
			snapshot.set(provider, [...merged.values()]);
		}
		const encode = (value: Catalog) => JSON.stringify({ version: 1, providers: Object.fromEntries(value) });
		const text = encode(snapshot);
		if (text === encode(state.snapshot)) return "unchanged";
		if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw new Error("Model catalog exceeds the snapshot limit");
		writeModelCatalogSnapshot(text);
		state.snapshot = snapshot;
		setModelCatalogOverlay(snapshot);
		return "updated";
	} finally { controller.abort(); }
}

/** Called exclusively by the manual POST. Concurrent clicks share one fetch. */
export function refreshModelCatalog(): Promise<ModelCatalogRefreshOutcome> {
	initializeModelCatalog();
	const state = catalogGlobal[STATE_KEY]!;
	return state.refreshing ??= refresh(state).finally(() => { state.refreshing = undefined; });
}
