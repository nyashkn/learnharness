import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ReviewPill, type ReviewPick } from "../components/review-pill.tsx";

const picks: ReviewPick[] = [{ id: "n_a", name: "A", statement: "sa" }, { id: "n_b", name: "B", statement: "sb" }];
const text = (q: Parameters<typeof ReviewPill>[0]["queue"]) =>
	parseHTML(`<body>${renderToStaticMarkup(<ReviewPill queue={q} onStart={() => {}} />)}</body>`).document.querySelector('[data-testid="review-pill"]')?.textContent ?? null;

describe("ReviewPill", () => {
	it("renders due and new counts", () => {
		assert.equal(text({ dueCount: 3, newCount: 2, picks }), "Review · 3 due · 2 new");
		assert.equal(text({ dueCount: 0, newCount: 2, picks }), "Review · 2 new");
	});
	it("renders nothing with no queue or no picks", () => {
		assert.equal(text(null), null);
		assert.equal(text({ dueCount: 0, newCount: 0, picks: [] }), null);
	});
	it("a click starts the review with the queue's picks", () => {
		let started: ReviewPick[] | null = null;
		const el = ReviewPill({ queue: { dueCount: 1, newCount: 1, picks }, onStart: (p) => { started = p; } }) as React.ReactElement<{ onClick: () => void }>;
		el.props.onClick();
		assert.deepEqual(started, picks);
	});
	it("is disabled while busy", () => {
		const html = renderToStaticMarkup(<ReviewPill queue={{ dueCount: 1, newCount: 0, picks }} busy onStart={() => {}} />);
		assert.match(html, /disabled/);
	});
});
