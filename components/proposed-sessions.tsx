"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { stashOpeningPrompt } from "@/components/opening-prompt";

/** GET /api/seed row (src/seed/panel.ts PanelRow). Components may not import src/seed, so the wire shape is restated. */
export interface ProposedSession {
	id: string;
	title: string;
	why: string;
	evidence: string[];
	prerequisiteFor: string | null;
	label: "learn" | null;
	acceptable: boolean;
}

// Module-level so the load effect's dependency is stable across renders.
const browserFetch: typeof fetch = (...args) => fetch(...args);
const START_FAILURE = "Couldn’t start that session. Try again.";
const DISMISS_FAILURE = "Couldn’t save that. Try again.";
const isRow = (r: unknown): r is ProposedSession =>
	!!r && typeof r === "object" && typeof (r as ProposedSession).id === "string" && typeof (r as ProposedSession).title === "string" && Array.isArray((r as ProposedSession).evidence);

/**
 * PROPOSED SESSIONS (K5): teaching sessions proposed from the learner's own agent history (seeds.sqlite). Start creates
 * a chat through POST /api/chats, records the accept, and opens the chat with the stored first message PREFILLED — the
 * learner sends it (stashed as attempted, chat.tsx's restore-not-send path). Dismiss records "know" or "skip". Each
 * click is a label for the seed calibration. Renders nothing when there is nothing to propose.
 */
export function ProposedSessions({
	canStart,
	navigate,
	fetchLike = browserFetch,
}: {
	/** Home's pre-send guards (setup, keys, model). False when it opened setup instead. */
	canStart: () => boolean;
	navigate: (href: string) => void;
	fetchLike?: typeof fetch;
}) {
	const [rows, setRows] = useState<ProposedSession[]>([]);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	// A created chat is reused on retry, so a failed accept never leaves a second empty session.
	const created = useRef(new Map<string, string>());

	useEffect(() => {
		let live = true;
		fetchLike("/api/seed")
			.then((res) => (res.ok ? res.json() : null))
			.then((body: { proposals?: unknown } | null) => {
				if (live && Array.isArray(body?.proposals)) setRows(body.proposals.filter(isRow));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [fetchLike]);

	if (rows.length === 0) return null;

	const post = (body: object) => fetchLike("/api/seed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

	const start = async (row: ProposedSession) => {
		if (busy || !row.acceptable || !canStart()) return;
		setBusy(row.id);
		setError(null);
		try {
			let chatId = created.current.get(row.id);
			if (!chatId) {
				const res = await fetchLike("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: row.title }) });
				const body = res.ok ? ((await res.json()) as { id?: unknown }) : null;
				if (typeof body?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.id)) throw new Error(START_FAILURE);
				chatId = body.id;
				created.current.set(row.id, chatId);
			}
			const res = await post({ action: "accept", id: row.id, chatId });
			const body = res.ok ? ((await res.json()) as { firstMessage?: unknown }) : null;
			if (typeof body?.firstMessage !== "string" || body.firstMessage === "") throw new Error(START_FAILURE);
			// attempted=true: the chat restores it into the composer and never sends it by itself
			if (!stashOpeningPrompt(chatId, body.firstMessage, true)) throw new Error(START_FAILURE);
			navigate(`/chat/${chatId}`);
		} catch {
			setError(START_FAILURE);
			setBusy(null);
		}
	};

	const dismiss = async (row: ProposedSession, verdict: "know" | "skip") => {
		if (busy) return;
		setBusy(row.id);
		setError(null);
		try {
			const res = await post({ action: "dismiss", id: row.id, verdict });
			if (!res.ok) throw new Error(DISMISS_FAILURE);
			setRows((current) => current.filter((r) => r.id !== row.id));
		} catch {
			setError(DISMISS_FAILURE);
		} finally {
			setBusy(null);
		}
	};

	const button =
		"rounded-sm border border-border bg-card px-2 py-1 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent disabled:opacity-40 disabled:hover:bg-card cursor-pointer disabled:cursor-default";

	return (
		<section aria-label="Proposed sessions" data-testid="seed-panel" className="mb-2">
			<button
				type="button"
				data-testid="seed-panel-toggle"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-1 rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
			>
				{open ? <ChevronDownIcon aria-hidden="true" className="size-3" /> : <ChevronRightIcon aria-hidden="true" className="size-3" />}
				{rows.length === 1 ? "1 proposed session" : `${rows.length} proposed sessions`} from your history
			</button>
			{open && (
				<ol className="mt-2 max-h-72 space-y-2 overflow-y-auto rounded-xl border bg-card/95 p-2 shadow-lg backdrop-blur">
					{rows.map((row) => (
						<li key={row.id} data-testid="seed-row" className="rounded-sm border border-border bg-background p-2">
							<p className="font-ui text-sm text-foreground">{row.title}</p>
							{row.why && <p className="mt-0.5 font-ui text-xs text-muted-foreground">{row.why}</p>}
							{row.evidence.length > 0 && (
								<ul className="mt-1 list-disc pl-4 font-ui text-xs text-muted-foreground">
									{row.evidence.map((e, i) => (
										<li key={i}>{e}</li>
									))}
								</ul>
							)}
							{row.prerequisiteFor && <p className="mt-1 font-ui text-xs text-muted-foreground">Comes before: {row.prerequisiteFor}</p>}
							<div className="mt-2 flex flex-wrap items-center gap-1.5">
								<button type="button" data-testid="seed-start" disabled={!row.acceptable || busy !== null} onClick={() => void start(row)} className={button}>
									Start session
								</button>
								<button type="button" data-testid="seed-know" disabled={busy !== null} onClick={() => void dismiss(row, "know")} className={button}>
									I know this
								</button>
								<button type="button" data-testid="seed-skip" disabled={busy !== null} onClick={() => void dismiss(row, "skip")} className={button}>
									Skip
								</button>
								{!row.acceptable && <span className="font-ui text-xs text-muted-foreground">Can’t start: some evidence is opted out or missing.</span>}
							</div>
						</li>
					))}
				</ol>
			)}
			{error && (
				<p role="alert" className="mt-1 text-sm text-destructive">
					{error}
				</p>
			)}
		</section>
	);
}
