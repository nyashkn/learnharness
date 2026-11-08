import { createEmptyCard, fsrs, type Card, type FSRS, type StepUnit } from "ts-fsrs";
import { gradeOf } from "./rating.ts";
import { FACTORY_SCHEDULER, type ReviewEvent, type SchedulerSettings } from "./types.ts";

/** One scheduler per distinct knob set. */
const schedulers = new Map<string, FSRS>();
export function schedulerFor(settings: SchedulerSettings = FACTORY_SCHEDULER): FSRS {
	const params = {
		request_retention: settings.desiredRetention,
		maximum_interval: settings.maximumIntervalDays,
		enable_fuzz: settings.fuzz,
		enable_short_term: settings.shortTerm,
		learning_steps: [...settings.learningSteps] as StepUnit[],
		relearning_steps: [...settings.relearningSteps] as StepUnit[],
	};
	const key = JSON.stringify(params);
	let scheduler = schedulers.get(key);
	if (!scheduler) schedulers.set(key, (scheduler = fsrs(params)));
	return scheduler;
}

/** Memory state is DERIVED, never stored: fold the events (in the order given) through FSRS-6.
 *  Returns null for an empty history (never practiced). Events with an unparseable `at` throw.
 *  Ledger order wins over clock order: ts-fsrs throws on time running backwards, so an event
 *  stamped earlier than its predecessor is replayed at the predecessor's time. */
export function replay(events: readonly ReviewEvent[], settings?: SchedulerSettings): Card | null {
	if (events.length === 0) return null;
	const scheduler = schedulerFor(settings);
	const at = (e: ReviewEvent): Date => {
		const d = new Date(e.at);
		if (Number.isNaN(d.getTime())) throw new RangeError(`review ${e.id}: bad timestamp ${e.at}`);
		return d;
	};
	let clock = at(events[0]!);
	let card = createEmptyCard(clock);
	for (const event of events) {
		const t = at(event);
		if (t > clock) clock = t;
		card = scheduler.next(card, clock, gradeOf(event)).card;
	}
	return card;
}

/** Predicted recall probability (0-1) of the replayed card at `now`; null if never practiced. */
export function retrievabilityAt(events: readonly ReviewEvent[], now: Date, settings?: SchedulerSettings): number | null {
	const card = replay(events, settings);
	return card ? schedulerFor(settings).retrievability(card, now) : null;
}
