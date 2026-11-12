/**
 * The quiz answer pressed while a turn is still running (lh-osh). The dock is up
 * before the turn that posed the question has closed, and the submission path
 * refuses while busy. Keep that ONE press (the last wins) and, once the client is
 * ready, replay it through the SAME prepare function a ready-state press uses, so
 * plugin interceptors, images and validation run exactly once.
 */
export class HeldBuiltinSubmission<Call extends { isCurrent(): boolean }> {
	private held: { call: Call; key: string } | null = null;

	/** Keep this press; it replaces any earlier one. */
	hold(call: Call, key: string): void { this.held = { call, key }; }

	/** Stop, chat change, or any other cancel. */
	clear(): void { this.held = null; }

	get pending(): boolean { return this.held !== null; }

	/** The turn is over: replay the held press once if its question is still the pending one.
	 *  `currentKey` reads the pending question's key NOW; the dock's own identity check is
	 *  replaced because an adopted record re-creates the question object. */
	replay(currentKey: () => string | undefined, prepare: (call: Call) => void): void {
		const held = this.held;
		if (!held) return;
		this.held = null;
		const sameQuestion = () => currentKey() === held.key;
		if (sameQuestion()) prepare({ ...held.call, isCurrent: sameQuestion });
	}
}
