/**
 * The practice doctrine's R3b text (upstream PR #486, ported verbatim): the per-mode size caps, the
 * skeleton-is-a-surface rule, the surface field in the base prompt, and the history-brief rules. These pin the
 * prompt text the model reads, so an accidental edit to the approved wording fails here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeInstructions } from "../src/agent/teacher-agent.ts";

const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();
const prompt = () => normalizeWhitespace(composeInstructions("practice"));

describe("practice doctrine (R3b)", () => {
	it("composes the approved mode size caps and the skeleton-is-a-surface rule (owner, 2026-11-03)", () => {
		const p = prompt();
		assert.ok(p.includes("One question — one asked output, one or two decision points; one target; a snippet of about ten lines at most"));
		assert.ok(p.includes("One twin pair — two near-identical situations differing only in the separating feature, one asked output each"));
		assert.ok(p.includes("One chain — length follows it, up to about three asked outputs and twenty-five lines"));
		assert.ok(p.includes("**The shapes are caps.**"));
		assert.ok(p.includes("A recall problem exercises exactly one target"));
		assert.ok(p.includes("the same skeleton with renamed types is a repeat"));
	});

	it("tells the model what the surface field is", () => {
		assert.ok(prompt().includes("The surface field names the situation class in one line — the kind of situation, never the target"));
	});

	it("carries the history-brief rules: start one mode up, repair at the failed layer, this session overrides", () => {
		const p = prompt();
		assert.ok(p.includes("often with a history brief of each one's earlier practice"));
		assert.ok(p.includes("- **History**: when the session context carries a history brief, it is prior evidence from earlier sessions."));
		assert.ok(p.includes("A target's highest clean mode counts as demonstrated — start it one mode up (composition stays composition)."));
		assert.ok(p.includes("This session's evidence overrides the brief the moment they disagree."));
		assert.ok(p.includes("Never re-ask in the same surface — this session's or the history brief's."));
	});
});
