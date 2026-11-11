import { NextRequest, NextResponse } from "next/server";
import { listMailboxes, connectMailbox } from "@/lib/outreach/mailboxes";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";
import type { ImapSmtpInput } from "@/lib/outreach/imapSmtpConfig";

// GET /api/outreach/mailboxes — list connected mailboxes.
export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const rows = await listMailboxes();
      return NextResponse.json({ mailboxes: rows });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

// POST /api/outreach/mailboxes — connect a mailbox:
//   { emailAddress, displayName?, signatureHtml?, provider?: "google" | "imap", imapSmtp? }
// Google (the default): no password/OAuth — just names the address; we test
// whether our service account's domain-wide delegation may impersonate it.
// "imap": imapSmtp holds the SMTP and IMAP servers and the mailbox's login
// (password optional when updating one that has it); both are tested first.
export async function POST(req: NextRequest) {
  try {
    return await withOrgContext(req, async () => {
      let body: { emailAddress?: string; displayName?: string; signatureHtml?: string; provider?: unknown; imapSmtp?: unknown };
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
      }

      if (!body.emailAddress) {
        return NextResponse.json({ error: "emailAddress is required" }, { status: 400 });
      }

      if (body.provider !== undefined && body.provider !== "google" && body.provider !== "imap") {
        return NextResponse.json({ error: 'provider must be "google" or "imap"' }, { status: 400 });
      }
      if (body.provider === "imap" && (typeof body.imapSmtp !== "object" || body.imapSmtp === null)) {
        return NextResponse.json({ error: "imapSmtp is required for an SMTP + IMAP mailbox" }, { status: 400 });
      }

      const result = await connectMailbox({
        emailAddress: body.emailAddress,
        displayName: body.displayName,
        signatureHtml: body.signatureHtml,
        provider: body.provider,
        imapSmtp: body.provider === "imap" ? (body.imapSmtp as ImapSmtpInput) : undefined,
      });
      if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
      }
      return NextResponse.json(result, { status: 201 });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
