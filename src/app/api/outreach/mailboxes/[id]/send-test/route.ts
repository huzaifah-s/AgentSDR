import { NextRequest, NextResponse } from "next/server";
import { getMailbox } from "@/lib/outreach/mailboxes";
import { sendEmail } from "@/lib/outreach/send";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";

// POST /api/outreach/mailboxes/[id]/send-test — { to } — sends a one-off
// test email from this mailbox so a user can confirm sending actually works
// before assigning it to a campaign.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(req, async () => {
      const { id } = await params;
      let body: { to?: string };
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.to) {
        return NextResponse.json({ error: "to is required" }, { status: 400 });
      }

      const mailbox = await getMailbox(id);
      if (!mailbox) return NextResponse.json({ error: "mailbox not found" }, { status: 404 });

      try {
        const result = await sendEmail({
          from: mailbox.emailAddress,
          to: [body.to],
          subject: "AgentSDR test email",
          text: `This is a test email from ${mailbox.emailAddress}, sent via AgentSDR to confirm the mailbox is working.`,
        });
        return NextResponse.json({ ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, error: message }, { status: 502 });
      }
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
