import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { HeldBuiltinSubmission, runSubmissionAttempt } from "../components/held-builtin-submission.ts";
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
	compacting = false;
	key = "q1";
	count = 0;
	sends: Sent[] = [];
	runner = new PluginSubmissionRunner();
	held = new HeldBuiltinSubmission<Call>();
	/** prepareBuiltin's tail: runSubmissionAttempt (the function chat.tsx runs), then the answer send. */
	prepare = (call: Call): void => {
		void runSubmissionAttempt({
			runner: this.runner, target: target(), registrations: [drawingPad], isCurrent: call.isCurrent, history: () => [],
			capture: () => { const raw = call.capture(); return { type: "answer" as const, answer: { dontKnow: true, images: [] }, thinking: { text: raw.thinking ?? "", images: [] }, readingThinking: { text: "", images: [] } }; },
			deliver: async (prepared, attempt) => {
				if (prepared.type !== "answer") return false;
				const images = submissionImages(prepared, target().channels);
				attempt.deliver();
				this.sends.push({ thinking: prepared.thinking.text, images: images?.answer?.length ?? 0 });
				attempt.accepted();
				return true;
			},
		});
	};
	/** The first fix's bypass: no runner, no interceptors. */
	bypass = (call: Call): void => { if (call.isCurrent()) this.sends.push({ thinking: call.capture().thinking ?? "", images: 0 }); };
	replayWith = this.prepare;
	press(): void {
		const n = this.count++;
		const call: Call = { question: qd, capture: () => ({ thinking: `t${n}` } as AnswerRequest), isCurrent: () => true };
		if (this.held.press(call, this.key, this.busy || this.compacting)) return;
		this.busy = true; this.prepare(call);
	}
	/** The busy/compacting effect in chat.tsx. */
	effect(): void { this.held.replay(this.busy || this.compacting, () => this.key, (call) => { this.busy = true; this.replayWith(call); }); }
	ready(): void { this.busy = false; this.effect(); }
	compactStart(): void { this.compacting = true; this.effect(); }
	compactEnd(): void { this.compacting = false; this.effect(); }
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

type Model = { busy: boolean; compacting: boolean; pending: { t: string; key: string } | null; key: string; sends: string[]; n: number };
type Cmd = fc.AsyncCommand<Model, Chat>;
const cmd = (name: string, run: (m: Model, c: Chat) => void): Cmd => ({ check: () => true, toString: () => name, async run(m, c) { run(m, c); await settle(); } });
const press = (m: Model, c: Chat) => { c.press(); const t = `t${m.n++}`; if (m.busy || m.compacting) m.pending = { t, key: m.key }; else { m.busy = true; m.sends.push(t); } };
const release = (m: Model) => { if (m.busy || m.compacting) return; const p = m.pending; m.pending = null; if (p && p.key === m.key) { m.sends.push(p.t); m.busy = true; } };
const commands = [
	cmd("press", press),
	cmd("doublePress", (m, c) => { press(m, c); press(m, c); }),
	cmd("ready", (m, c) => { c.ready(); m.busy = false; release(m); }),
	cmd("compactStart", (m, c) => { c.compactStart(); m.compacting = true; }),
	cmd("compactEnd", (m, c) => { c.compactEnd(); m.compacting = false; release(m); }),
	cmd("stop", (m, c) => { c.held.clear(); c.busy = false; c.compacting = false; m.pending = null; m.busy = false; m.compacting = false; }),
	cmd("chatChange", (m, c) => { c.held.clear(); m.pending = null; }),
	cmd("questionLeaves", (m, c) => { c.key = `q${m.n}x`; m.key = c.key; }),
];

async function verify(bypass: boolean) {
	await fc.assert(fc.asyncProperty(fc.commands(commands.map((c) => fc.constant(c)), { size: "+1" }), async (cmds) => {
		const chat = new Chat();
		if (bypass) chat.replayWith = chat.bypass;
		const model: Model = { busy: true, compacting: false, pending: null, key: "q1", sends: [], n: 0 };
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
	it("compaction starting as the turn ends keeps the press held, then sends it once after compaction", async () => {
		const c = new Chat(); c.press(); await settle();
		c.compactStart(); c.ready(); await settle(); assert.deepEqual(c.sends, [], "held through compaction");
		c.compactEnd(); await settle(); c.compactEnd(); await settle();
		assert.deepEqual(c.sends, [{ thinking: "t0", images: 1 }]);
	});
	it("property: one send per held press, held through compaction, none after Stop / chat change / question leaving, attachment always present", () => verify(false));
	it("breaks if the replay bypasses prepare", async () => { await assert.rejects(verify(true)); });
});
