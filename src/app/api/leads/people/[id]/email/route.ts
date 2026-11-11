import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { assertSameOriginMutation, CrmRequestError } from "@/lib/crm/http";
import { ManualEmailError, sendManualEmail } from "@/lib/leads/manualEmail";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/leads/people/[id]/email — { mailboxId, subject, body }: one email
 * to this person from a connected Google Workspace mailbox (the person drawer
 * on Leads). 409 when Google Workspace is not connected, the mailbox is not,
 * or the person is Do Not Contact / suppressed; 429 when the mailbox is at its
 * daily limit or inside its sending gap; 502 when Gmail refused the send.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    assertSameOriginMutation(req);
  } catch (error) {
    if (error instanceof CrmRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  if (!UUID_SHAPE.test(id)) return NextResponse.json({ error: "Person not found" }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body is required" }, { status: 400 });
  if (typeof body.mailboxId !== "string" || !UUID_SHAPE.test(body.mailboxId)) {
    return NextResponse.json({ error: "Choose a mailbox to send from" }, { status: 400 });
  }
  try {
    return await withOrgContext(req, async (ctx) => {
      try {
        const result = await sendManualEmail({
          personId: id,
          mailboxId: body.mailboxId,
          subject: body.subject,
          body: body.body,
          actorRef: ctx.userEmail,
        });
        return NextResponse.json(result);
      } catch (error) {
        if (error instanceof ManualEmailError) return NextResponse.json({ error: error.message }, { status: error.status });
        if (isPlatformNotConnectedError(error)) return NextResponse.json({ error: error.message }, { status: 409 });
        // Anything else is Gmail's answer to the send itself.
        const message = error instanceof Error ? error.message : String(error);
        console.error("[leads/email] send failed:", error);
        return NextResponse.json({ error: `Gmail did not send the email: ${message}` }, { status: 502 });
      }
    });
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}
