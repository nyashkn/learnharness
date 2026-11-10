/**
 * Review settings: the read-side sanitizer (clamp, never reject), the write-side body parser (reject, never clamp),
 * resolution to factory values, and reviewSummary scheduling with the resolved settings.
 * Expected values come from hand-listed cases or independent oracles (sort-based clamp, a constructed-valid step
 * generator), never from the code under test.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import fc from "fast-check";
import type { GraphNode } from "../src/core/contracts.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { FACTORY_SETTINGS, parseReviewSteps, sanitizeUserSettings } from "../src/core/settings.ts";
import { parseReviewSettingsBody } from "../src/server/settings-body.ts";
import { reviewSummary } from "../src/server/review.ts";
import { createGraphStore } from "../src/store/graph.ts";

const sanitizeReview = (review: unknown) => sanitizeUserSettings({ version: 1, review })?.review;
const finite = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 });
const median = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y)[1]!;

/** Steps built valid by construction: a positive number (integer or decimal) + m/h/d. */
const validStep = fc
  .tuple(fc.oneof(fc.integer({ min: 1, max: 9999 }).map(String), fc.tuple(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 1, max: 99 })).map(([a, b]) => `${a}.${b}`)), fc.constantFrom("m", "h", "d"))
  .map(([n, u]) => `${n}${u}`);
/** Steps built invalid by construction: wrong unit, no number, zero, negative, stray whitespace, non-string. */
const invalidStep = fc.oneof(
  fc.integer({ min: 1, max: 99 }).chain((n) => fc.constantFrom("s", "w", "M", "H", "", "mm").map((u) => `${n}${u}`)),
  fc.constantFrom("m", "h", "d", "", "abc", "0m", "0d", "0.0h", "-1m", "1 m", " 1m", "1m ", "1.m", "1e3m"),
);

describe("sanitizeReview (read side: clamp, never reject)", () => {
  it("RS1 desiredRetention clamps into [0.7, 0.99] (property, sort-median oracle)", () => {
    fc.assert(fc.property(finite, (r) => {
      assert.equal(sanitizeReview({ desiredRetention: r })?.desiredRetention, median(0.7, r, 0.99));
    }));
  });

  it("RS2 maximumIntervalDays floors to a whole day, minimum 1 (property)", () => {
    fc.assert(fc.property(finite, (d) => {
      const expected = Math.floor(d) >= 1 ? Math.floor(d) : 1;
      assert.equal(sanitizeReview({ maximumIntervalDays: d })?.maximumIntervalDays, expected);
    }));
  });

  it("RS3 newPerDay: negative drops, otherwise floors (property)", () => {
    fc.assert(fc.property(finite, (n) => {
      const got = sanitizeReview({ newPerDay: n })?.newPerDay;
      if (n < 0) assert.equal(got, undefined);
      else assert.equal(got, Math.floor(n));
    }));
  });

  it("RS4 wrong types drop; they never throw and never reject the record (property)", () => {
    const junk = fc.oneof(fc.string(), fc.boolean(), fc.constant(null), fc.constant(NaN), fc.constant(Infinity), fc.array(fc.anything(), { maxLength: 2 }));
    fc.assert(fc.property(junk, junk, junk, (a, b, c) => {
      const got = sanitizeReview({ newPerDay: a, desiredRetention: b, maximumIntervalDays: c, fuzz: a, shortTerm: b, learningSteps: c, relearningSteps: a });
      assert.ok(got !== undefined);
      for (const key of ["newPerDay", "desiredRetention", "maximumIntervalDays"] as const) {
        if (got[key] !== undefined) assert.ok(Number.isFinite(got[key]));
      }
    }));
  });

  it("RS5 idempotent: sanitizing a sanitized section changes nothing (property)", () => {
    fc.assert(fc.property(finite, finite, finite, fc.array(fc.oneof(validStep, invalidStep), { maxLength: 3 }), (n, r, d, steps) => {
      const once = sanitizeReview({ newPerDay: n, desiredRetention: r, maximumIntervalDays: d, learningSteps: steps });
      assert.deepEqual(sanitizeReview(once), once);
    }));
  });

  it("RS6 a step list with one bad entry drops whole; a good list is kept", () => {
    assert.equal(sanitizeReview({ learningSteps: ["1m", "bogus"] })?.learningSteps, undefined);
    assert.deepEqual(sanitizeReview({ learningSteps: ["1m", "10m"], relearningSteps: [] }), { learningSteps: ["1m", "10m"], relearningSteps: [] });
  });

  it("RS7 booleans pass through; the appearance colour keeps hex or null", () => {
    assert.deepEqual(sanitizeReview({ fuzz: true, shortTerm: false }), { fuzz: true, shortTerm: false });
    assert.equal(sanitizeUserSettings({ version: 1, appearance: { reviewHeatmapColor: "#3366ff" } })?.appearance?.reviewHeatmapColor, "#3366ff");
    assert.equal(sanitizeUserSettings({ version: 1, appearance: { reviewHeatmapColor: null } })?.appearance?.reviewHeatmapColor, null);
    assert.equal(sanitizeUserSettings({ version: 1, appearance: { reviewHeatmapColor: "green" } })?.appearance?.reviewHeatmapColor, null);
  });
});

describe("resolveSettings: review", () => {
  it("RR1 absent section resolves to the factory values, listed by hand", () => {
    assert.deepEqual(resolveSettings(null).review, {
      newPerDay: 10, desiredRetention: 0.9, maximumIntervalDays: 36500, fuzz: false, shortTerm: true,
      learningSteps: ["1m", "10m"], relearningSteps: ["10m"],
    });
    assert.deepEqual(FACTORY_SETTINGS.review, resolveSettings(null).review);
    assert.equal(resolveSettings(null).appearance.reviewHeatmapColor, null);
  });

  it("RR2 stored knobs override; absent ones stay factory", () => {
    const r = resolveSettings({ version: 1, review: { newPerDay: 0, fuzz: true }, appearance: { reviewHeatmapColor: "#112233" } });
    assert.equal(r.review.newPerDay, 0, "0 pauses new material, not falling back to 10");
    assert.equal(r.review.fuzz, true);
    assert.equal(r.review.desiredRetention, 0.9);
    assert.equal(r.appearance.reviewHeatmapColor, "#112233");
  });
});

describe("parseReviewSettingsBody (write side: reject, never clamp)", () => {
  it("WB1 newPerDay accepts exactly the whole numbers >= 0 (property)", () => {
    fc.assert(fc.property(fc.oneof(finite, fc.integer({ min: -5, max: 1000 })), (n) => {
      assert.equal(parseReviewSettingsBody({ newPerDay: n }).ok, Number.isInteger(n) && n >= 0);
    }));
  });

  it("WB2 desiredRetention accepts exactly [0.7, 0.99] and stores it unchanged (property)", () => {
    fc.assert(fc.property(fc.double({ noNaN: true, min: 0, max: 1.5 }), (r) => {
      const res = parseReviewSettingsBody({ desiredRetention: r });
      assert.equal(res.ok, r >= 0.7 && r <= 0.99);
      if (res.ok) assert.equal(res.settings.desiredRetention, r);
    }));
    assert.equal(parseReviewSettingsBody({ desiredRetention: NaN }).ok, false);
    assert.equal(parseReviewSettingsBody({ desiredRetention: Infinity }).ok, false);
  });

  it("WB3 maximumIntervalDays accepts exactly whole numbers >= 1 (property)", () => {
    fc.assert(fc.property(fc.oneof(finite, fc.integer({ min: -5, max: 40000 })), (d) => {
      assert.equal(parseReviewSettingsBody({ maximumIntervalDays: d }).ok, Number.isInteger(d) && d >= 1);
    }));
  });

  it("WB4 step lists: all-valid accepted verbatim; any invalid entry rejects the list (property)", () => {
    fc.assert(fc.property(fc.array(validStep, { maxLength: 4 }), (steps) => {
      for (const key of ["learningSteps", "relearningSteps"] as const) {
        const res = parseReviewSettingsBody({ [key]: steps });
        assert.ok(res.ok);
        assert.deepEqual(res.settings[key], steps);
      }
    }));
    fc.assert(fc.property(fc.array(validStep, { maxLength: 3 }), invalidStep, fc.array(validStep, { maxLength: 3 }), (a, bad, b) => {
      assert.equal(parseReviewSettingsBody({ learningSteps: [...a, bad, ...b] }).ok, false);
      assert.equal(parseReviewSettingsBody({ relearningSteps: [...a, bad, ...b] }).ok, false);
      assert.equal(parseReviewSteps([...a, bad, ...b]), null);
    }));
    assert.equal(parseReviewSettingsBody({ learningSteps: [5] }).ok, false);
    assert.equal(parseReviewSettingsBody({ learningSteps: "1m" }).ok, false);
  });

  it("WB5 booleans must be booleans; non-objects reject; absent keys are absent", () => {
    assert.equal(parseReviewSettingsBody({ fuzz: 1 }).ok, false);
    assert.equal(parseReviewSettingsBody({ shortTerm: "yes" }).ok, false);
    assert.equal(parseReviewSettingsBody(null).ok, false);
    assert.equal(parseReviewSettingsBody([]).ok, false);
    assert.deepEqual(parseReviewSettingsBody({}), { ok: true, settings: {} });
    assert.deepEqual(parseReviewSettingsBody({ fuzz: false, shortTerm: true, newPerDay: 0 }), { ok: true, settings: { fuzz: false, shortTerm: true, newPerDay: 0 } });
  });
});

describe("reviewSummary schedules with the review settings", () => {
  let dir: string;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-settings-")); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const node = (id: string): GraphNode => ({ id, name: `name ${id}`, statement: `statement ${id}`, aliases: [], createdAt: "2026-01-01T00:00:00.000Z", provenance: [] });
  const now = new Date("2026-06-01T12:00:00.000Z");

  it("SS1 newCount follows review.newPerDay (property: min(cap, fresh))", () => {
    const graph = createGraphStore(fs.mkdtempSync(path.join(dir, "g-")));
    for (const id of ["n_1", "n_2", "n_3", "n_4", "n_5"]) graph.appendNode(node(id));
    fc.assert(fc.property(fc.integer({ min: 0, max: 8 }), (cap) => {
      const s = reviewSummary(now, graph, { ...FACTORY_SETTINGS.review, newPerDay: cap });
      assert.equal(s.newCount, Math.min(cap, 5));
    }));
  });

  it("SS2 the scheduler knobs reach the replay: a miss 30 seconds ago is due with short-term steps, not without", () => {
    const graph = createGraphStore(fs.mkdtempSync(path.join(dir, "g-")));
    graph.appendNode(node("n_a"));
    graph.appendReview({ id: "c:p1", chatId: "c", problemCallId: "p1", at: new Date(now.getTime() - 30_000).toISOString(), targets: ["n_a"], outcome: "surrendered", rung: "R5" });
    assert.equal(reviewSummary(now, graph, { ...FACTORY_SETTINGS.review, shortTerm: true }).dueCount, 0, "first learning step is 1 minute");
    assert.equal(reviewSummary(new Date(now.getTime() + 20 * 60_000), graph, { ...FACTORY_SETTINGS.review, shortTerm: true }).dueCount, 1);
    assert.equal(reviewSummary(new Date(now.getTime() + 20 * 60_000), graph, { ...FACTORY_SETTINGS.review, shortTerm: false }).dueCount, 0, "without steps the miss waits a day");
  });
});
