/**
 * The one way to send an email from a mailbox, whatever its provider: every
 * sender (campaign scheduler, CRM replies and follow-ups, one-off emails from
 * Leads, the mailbox's test send) calls `sendEmail` with the mailbox address
 * as `from`, and this picks Gmail or SMTP by the mailbox's `provider`.
 *
 * Runs in the organization scope: `from` must be a mailbox of the current
 * organization. A Google mailbox needs the Google Workspace integration
 * (PlatformNotConnectedError otherwise, which callers treat as nothing sent).
 */
import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { sendGmailEmail, type SendEmailParams, type SendEmailResult } from "./gmail";
import { loadImapSmtpLogin, sendSmtpEmail } from "./imapSmtp";
import { mailboxes, type MailboxProvider } from "./schema";

export type { SendEmailParams, SendEmailResult } from "./gmail";

/** Nothing was sent: the mailbox is unknown here or has no stored login. */
export class MailboxNotSendableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxNotSendableError";
  }
}

export async function mailboxProvider(emailAddress: string): Promise<{ id: string; provider: MailboxProvider } | null> {
  const [row] = await db
    .select({ id: mailboxes.id, provider: mailboxes.provider })
    .from(mailboxes)
    .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, emailAddress.trim().toLowerCase())))
    .limit(1);
  return row ?? null;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const mailbox = await mailboxProvider(params.from);
  // A Google Workspace address can be impersonated without a mailbox row (as
  // before providers existed), so only an IMAP mailbox needs its row.
  if (mailbox?.provider === "imap") {
    const login = await loadImapSmtpLogin(mailbox.id);
    if (!login) throw new MailboxNotSendableError(`${params.from} has no SMTP login saved — add the mailbox again with its password`);
    return sendSmtpEmail(login, params);
  }
  return sendGmailEmail(params);
}
