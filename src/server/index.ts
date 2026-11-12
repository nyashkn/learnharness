/**
 * THE SERVER-SIDE SURFACE — the only src module (besides the core barrel)
 * that app/ may import. Route handlers and server components come through
 * here; nothing under app/ touches src/store or src/agent directly.
 */

export * from "./chat-handler.ts";
export * from "./events-stream.ts";
export * from "./chats.ts";
export * from "./graph.ts";
export * from "./source-organization.ts";
export * from "./source-deletion.ts";
export { NotesImportError } from "../agent/subagents/extraction.ts";
export { convertPdf } from "../agent/subagents/pdf-ops.ts";
export { joinPages } from "../agent/subagents/pdf-markdown.ts";
export * from "./commit-positions.ts";
export * from "./jobs.ts";
export { prepareSubmissionImages, prepareSubmissionImageChannels } from "./submission-images.ts";
export * from "./stores.ts";
export * from "./seeds.ts";
export { refreshWorkerRequestAdmission } from "../agent/worker-request-admission.ts";
export { readThemeBoot, type ThemeBoot } from "./theme-boot.ts";
// Prompt-segment validation for the settings routes. The settings *Record aliases
// (readSettingsRecord, writeSettingsRecord), the prompt overrides and themeStore come from ./stores.ts above.
export { isValidSegmentPath } from "../core/prompt-segments.ts";
// The canonical segment discovery/resolution lives in the agent layer
// (composition is an agent concern); the barrel re-exports it for the
// routes — server→agent is the lawful direction (chat-handler precedent).
export { effectivePromptSegments, allSegmentPaths } from "../agent/prompt-segments.ts";

// The auth/keys composition (auth-keys wave, 2026-09-19): the curated
// key catalog + the env-reflecting store behind GET/PUT/DELETE /api/keys.
// Importing this module runs the idempotent boot fill-gap — every consumer
// keeps its plain process.env reads (that seam is the point).
export * from "./keys.ts";
export * from "./search.ts";
export * from "./settings-body.ts";
export { fileAccessConfigurationError } from "./file-access.ts";
export * from "./turn-liveness.ts";
export * from "./turn-runs.ts";
export * from "./dismissal-park.ts";
export * from "./compaction.ts";
export { sideChats, createSideChatService, type SideChatService, type SideChatDeps, type SideStreamEvent } from "./side-chat.ts";
export { runPiTurn, piTurnResponse, type PiTurnHandle, type PiTurnSpec } from "./pi/ui-stream.ts";
export * from "./observability.ts";
export { abortPluginWorkerActivity } from "./plugin-worker-activity.ts";
export * from "./model-catalog.ts";
export { subscriptionControlsResponse, subscriptionBrowserResponse } from "./web-subscription-http.ts";
export { sessionCost } from "./pricing.ts";
export { initializePlugins, getPluginHost, getPluginAgentContributions, getPluginQuestionTypeResolver, pluginTransport } from "./plugins.ts";
export { createPluginDocumentRoute } from "./plugin-transport.ts";
export { pluginProblemAvailabilityOf, type ProblemTypeResolver } from "./plugin-problems.ts";
export { pluginQuestionAvailabilityOf, reconcilePluginQuestionCompatibility, preparePluginQuestionDismissal, type QuestionTypeResolver } from "./plugin-questions.ts";
export { claudeCodeInstallationResponse } from "./claude-code.ts";
// The custom endpoint module (registers into piModels() + probes for models).
// No import side effects here; the custom-endpoint boot sync lives at the bottom of keys.ts.
export * from "./custom-provider.ts";
export { customProviderGet, customProviderMutation } from "./custom-provider-http.ts";
export * from "./review.ts";
