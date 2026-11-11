/** A tiny OpenAI-compatible chat server that plays a fixed script: no keys, no network beyond 127.0.0.1.
 *  Teach chat: turn 1 calls the prober's `probe` (or `quiz`), then text. Practice chat: calls `problem` on `state.target`, then `conclude` once the learner answers, then text.
 *  Any call without the teacher tools (titles, extraction, summaries) gets a short text. */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface ScriptState { target: string; requests: number }
type Msg = { role: string; tool_calls?: { function: { name: string } }[]; name?: string };

const QUIZ = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury", explanation: "Mercury is the innermost planet.", type: "check", nodeId: "planet-order",
};

export function decide(body: { messages?: Msg[]; tools?: { function: { name: string } }[] }, state: ScriptState): { text?: string; call?: { name: string; args: unknown } } {
	const tools = new Set((body.tools ?? []).map((t) => t.function.name));
	const called = new Set((body.messages ?? []).flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.function.name) : [])));
	const last = (body.messages ?? []).at(-1);
	if (tools.has("problem") && tools.has("conclude")) {
		if (!called.has("problem")) return { call: { name: "problem", args: { statement: "State the rule: what is 2 + 2?", mode: "recall", surface: "single-step arithmetic recall", target: [state.target], modelSolution: "2 + 2 = 4." } } };
		if (!called.has("conclude") && last?.role === "user") return { call: { name: "conclude", args: { outcome: "solved", verdict: "Correct.", rung: null, missClass: null, retest: false } } };
		return { text: "Well done." };
	}
	// A new teach chat starts with the prober, whose multiple-choice tool is `probe` (no type/nodeId); later turns use `quiz`.
	const ask = tools.has("probe") ? "probe" : tools.has("quiz") ? "quiz" : null;
	if (ask && !called.has("probe") && !called.has("quiz")) {
		const { type: _t, nodeId: _n, ...bare } = QUIZ;
		return { call: { name: ask, args: ask === "probe" ? bare : QUIZ } };
	}
	return { text: ask ? "Right: Mercury it is." : "Scripted reply." };
}

function sse(res: http.ServerResponse, delta: object, finish: string | null, usage = false): void {
	const chunk = { id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 0, model: "scripted", choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) };
	res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export async function startScriptedModel(state: ScriptState): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		if (req.method === "GET" && req.url?.endsWith("/models")) {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ object: "list", data: [{ id: "scripted", object: "model" }] }));
			return;
		}
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.statusCode = 404; res.end(); return; }
		const parts: Buffer[] = [];
		req.on("data", (d: Buffer) => parts.push(d));
		req.on("end", () => {
			state.requests++;
			const step = decide(JSON.parse(Buffer.concat(parts).toString("utf8")), state);
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, { role: "assistant", content: "" }, null);
			if (step.call) {
				sse(res, { tool_calls: [{ index: 0, id: `call_${state.requests}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] }, null);
				sse(res, {}, "tool_calls");
			} else {
				sse(res, { content: step.text }, null);
				sse(res, {}, "stop");
			}
			sse(res, {}, null, true);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
