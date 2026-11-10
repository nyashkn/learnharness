/**
 * /api/seed — the home "Proposed sessions" panel (K5).
 * GET lists stored proposals. POST records an accept (for a chat the client created through POST /api/chats) or a
 * dismiss (know or skip). Both write a label the seed calibration reads. No model is called, and nothing is imported
 * into the graph (K-D1): the stored first message only prefills the new chat's composer.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import { acceptSeed, dismissSeed, seedPanel, SeedPanelUnavailableError } from "@/src/server";

export const dynamic = "force-dynamic";

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Body = Type.Union([
	Type.Object({ action: Type.Literal("accept"), id: Id, chatId: Type.String({ pattern: "^[A-Za-z0-9_-]+$", maxLength: 200 }) }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("dismiss"), id: Id, verdict: Type.Union([Type.Literal("know"), Type.Literal("skip")]) }, { additionalProperties: false }),
]);

const REFUSED: Record<string, [number, string]> = {
	"not-found": [404, "No such proposal"],
	"no-chat": [404, "No such session"],
	"not-open": [409, "This proposal is already accepted or dismissed"],
	"no-evidence": [409, "This proposal has no evidence to start from"],
	"opted-out": [409, "Some of this proposal's evidence is opted out, so it cannot start a session"],
};

const unavailable = (error: unknown) => {
	if (error instanceof SeedPanelUnavailableError) return Response.json({ error: error.message }, { status: 503 });
	throw error;
};

export async function GET() {
	try {
		return Response.json({ proposals: await seedPanel() });
	} catch (error) {
		return unavailable(error);
	}
}

export async function POST(req: Request) {
	const body: unknown = await req.json().catch(() => null);
	if (!Value.Check(Body, body)) return Response.json({ error: "Expected {action: accept, id, chatId} or {action: dismiss, id, verdict: know|skip}" }, { status: 400 });
	try {
		const result = body.action === "accept" ? await acceptSeed({ proposalId: body.id, chatId: body.chatId }) : dismissSeed({ proposalId: body.id, verdict: body.verdict });
		if (result.kind === "accepted") return Response.json({ firstMessage: result.firstMessage });
		if (result.kind === "dismissed") return Response.json({ ok: true });
		const [status, error] = REFUSED[result.kind]!;
		return Response.json({ error }, { status });
	} catch (error) {
		return unavailable(error);
	}
}
