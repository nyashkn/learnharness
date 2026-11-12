import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { HeldBuiltinSubmission } from "../components/held-builtin-submission.ts";
import { PluginSubmissionRunner, type SubmissionInterceptorRegistration } from "../components/plugin-submission-runner.ts";
import { submissionImages } from "../components/plugin-submission-adapters.ts";
import { toClientQuestion, type AnswerRequest, type PluginSubmissionTarget, type PluginSurfaceTarget, type QuestionData } from "../src/core/index.ts";

/**
 * A quiz answer pressed mid-turn must replay through the FULL prepare path: the real
 * PluginSubmissionRunner runs a real interceptor that attaches an image (Drawing Pad's
 * drawing), and the send carries it. The glue below mirrors chat.tsx's prepareBuiltin
 * (begin → finalize → prepare → submissionImages → send).
 */
const qd = { id: "q1", kind: "quiz", question: "Q?", mode: "single-select", options: [], createdAt: "fixture" } as unknown as QuestionData;
const PNG = "iVBORw0KGgo="; // canonical base64
const target = (): PluginSubmissionTarget => ({ type: "answer", sessionId: "chat", sessionKind: "teaching", surfaceTarget: {} as PluginSurfaceTarget, channels: ["answer", "thinking"],
	question: { ...toClientQuestion(qd), occurrence: { messageId: "m", contentIndex: 0, toolCallId: "q1", toolName: "quiz" } } } as PluginSubmissionTarget);
/** The plugin: attaches a drawing to the answer. */
const drawingPad: SubmissionInterceptorRegistration = {
	pluginId: "drawing-pad", pluginName: "Drawing Pad", signal: new AbortController().signal, isCurrent: () => true, report: () => {},
	interceptor: { id: "attach", intercept(input) {
		if (input.type !== "answer") return;
		return { ...input, answer: { ...input.answer, images: [...input.answer.images, { type: "image", data: PNG, mimeType: "image/png" }] } };
	} },
};

type Call = { question: QuestionData; capture(): AnswerRequest; isCurrent(): boolean };
type Sent = { thinking: string; images: number };

class Chat {
	busy = true;
	key = "q1";
	count = 0;
	sends: Sent[] = [];
	runner = new PluginSubmissionRunner();
	held = new HeldBuiltinSubmission<Call>();
	/** prepareBuiltin: the full upstream path. */
	prepare = (call: Call): void => {
		const attempt = this.runner.begin(target(), [drawingPad], call.isCurrent);
		if (!attempt) return;
		void (async () => {
			try {
				const raw = call.capture();
				const input = await attempt.finalize(() => ({ type: "answer" as const, answer: { dontKnow: true, images: [] }, thinking: { text: raw.thinking ?? "", images: [] }, readingThinking: { text: "", images: [] } }));
				const prepared = await attempt.prepare(input, []);
				if (!prepared || prepared.type !== "answer") return attempt.refused();
				const images = submissionImages(prepared, target().channels);
				attempt.deliver();
				this.sends.push({ thinking: prepared.thinking.text, images: images?.answer?.length ?? 0 });
				attempt.accepted();
			} catch { attempt.refused(); }
		})();
	};
	/** The first fix's bypass: no runner, no interceptors. */
	bypass = (call: Call): void => { if (call.isCurrent()) this.sends.push({ thinking: call.capture().thinking ?? "", images: 0 }); };
	replayWith = this.prepare;
	press(): void {
		const n = this.count++;
		const call: Call = { question: qd, capture: () => ({ thinking: `t${n}` } as AnswerRequest), isCurrent: () => true };
		if (this.busy) this.held.hold(call, this.key); else { this.busy = true; this.prepare(call); }
	}
	ready(): void { this.busy = false; this.held.replay(() => this.key, (call) => { this.busy = true; this.replayWith(call); }); }
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

type Model = { busy: boolean; pending: { t: string; key: string } | null; key: string; sends: string[]; n: number };
type Cmd = fc.AsyncCommand<Model, Chat>;
const cmd = (name: string, run: (m: Model, c: Chat) => void): Cmd => ({ check: () => true, toString: () => name, async run(m, c) { run(m, c); await settle(); } });
const press = (m: Model, c: Chat) => { c.press(); const t = `t${m.n++}`; if (m.busy) m.pending = { t, key: m.key }; else { m.busy = true; m.sends.push(t); } };
const commands = [
	cmd("press", press),
	cmd("doublePress", (m, c) => { press(m, c); press(m, c); }),
	cmd("ready", (m, c) => { c.ready(); m.busy = false; const p = m.pending; m.pending = null; if (p && p.key === m.key) { m.sends.push(p.t); m.busy = true; } }),
	cmd("stop", (m, c) => { c.held.clear(); c.busy = false; m.pending = null; m.busy = false; }),
	cmd("chatChange", (m, c) => { c.held.clear(); m.pending = null; }),
	cmd("questionLeaves", (m, c) => { c.key = `q${m.n}x`; m.key = c.key; }),
];

async function verify(bypass: boolean) {
	await fc.assert(fc.asyncProperty(fc.commands(commands.map((c) => fc.constant(c)), { size: "+1" }), async (cmds) => {
		const chat = new Chat();
		if (bypass) chat.replayWith = chat.bypass;
		const model: Model = { busy: true, pending: null, key: "q1", sends: [], n: 0 };
		await fc.asyncModelRun(() => ({ model, real: chat }), cmds);
		assert.deepEqual(chat.sends.map((s) => s.thinking), model.sends, "one send per held press (last wins), none after Stop, chat change or the question leaving");
		assert.ok(chat.sends.every((s) => s.images === 1), "every send carries the interceptor's attachment");
	}), { numRuns: 150 });
}

describe("answer pressed mid-turn replays through the full prepare path", () => {
	it("a held press is sent once on ready, carrying the interceptor's drawing", async () => {
		const c = new Chat(); c.press(); await settle(); assert.deepEqual(c.sends, []);
		c.ready(); await settle(); c.ready(); await settle();
		assert.deepEqual(c.sends, [{ thinking: "t0", images: 1 }]);
	});
	it("property: one send per held press, none after Stop / chat change / question leaving, attachment always present", () => verify(false));
	it("breaks if the replay bypasses prepare", async () => { await assert.rejects(verify(true)); });
});
