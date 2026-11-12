import type { LhMessage, PluginSubmission, PluginSubmissionTarget } from "../src/core/index.ts";
import type { PluginSubmissionRunner, SubmissionAttempt, SubmissionInterceptorRegistration } from "./plugin-submission-runner.ts";

/**
 * The quiz answer pressed while a turn is running or the session compacts (lh-osh). The dock is
 * up before the turn that posed the question has closed, and the submission path refuses while
 * busy. Keep that ONE press (the last wins) and, once the client is free, replay it through the
 * SAME prepare path a ready-state press uses, so plugin interceptors, images and validation run
 * exactly once. chat.tsx and the tests call these same functions.
 */
export class HeldBuiltinSubmission<Call extends { isCurrent(): boolean }> {
	private held: { call: Call; key: string } | null = null;

	/** The press decision. `blocked` = a turn is running or compaction is. Returns true when the
	 *  press was held (the caller stops); false means the caller sends it now. */
	press(call: Call, key: string, blocked: boolean): boolean {
		if (!blocked) return false;
		this.held = { call, key };
		return true;
	}

	/** Stop, chat change, or any other cancel. */
	clear(): void { this.held = null; }

	/** The client may be free: replay the held press once if its question is still the pending one.
	 *  While `blocked` the press stays held (compaction can start as the turn ends).
	 *  `currentKey` reads the pending question's key NOW; the dock's own identity check is
	 *  replaced because an adopted record re-creates the question object. */
	replay(blocked: boolean, currentKey: () => string | undefined, prepare: (call: Call) => void): void {
		const held = this.held;
		if (!held || blocked) return;
		this.held = null;
		const sameQuestion = () => currentKey() === held.key;
		if (sameQuestion()) prepare({ ...held.call, isCurrent: sameQuestion });
	}
}

/** One submission attempt: reserve, capture, run every registered interceptor, deliver. The one
 *  function chat.tsx's runSubmission and the tests both run. */
export async function runSubmissionAttempt(o: {
	runner: PluginSubmissionRunner;
	target: PluginSubmissionTarget;
	registrations: readonly SubmissionInterceptorRegistration[];
	isCurrent: () => boolean;
	capture: () => PluginSubmission | Promise<PluginSubmission>;
	history: () => readonly LhMessage[];
	deliver: (prepared: PluginSubmission, attempt: SubmissionAttempt) => Promise<boolean>;
	onBegin?: () => void;
	onError?: (message: string) => void;
}): Promise<boolean> {
	const attempt = o.runner.begin(o.target, o.registrations, o.isCurrent);
	if (!attempt) return false;
	o.onBegin?.();
	try {
		const input = await attempt.finalize(o.capture);
		const prepared = await attempt.prepare(input, o.history());
		if (!prepared) return false;
		attempt.check();
		return await o.deliver(prepared, attempt);
	} catch (error) {
		attempt.cancel(); attempt.refused();
		if (!(error instanceof DOMException && error.name === "AbortError")) o.onError?.(attempt.preparationFailure(error).message);
		return false;
	}
}
