import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pickInRange } from "@/lib/channels/rules";
import { channelRules } from "@/lib/channels/rules.server";
import { appendCrmEvent } from "@/lib/crm/events";
import { isEmailDoNotContact, isPersonDoNotContact } from "@/lib/crm/policies";
import { withCrmTransaction } from "@/lib/crm/repository";
import { recordManualOutboundInTransaction } from "@/lib/crm/manualOutbound";
import { sendEmail } from "@/lib/outreach/send";
import { toHtmlBody } from "@/lib/outreach/render";
import { mailboxes } from "@/lib/outreach/schema";
import { isSuppressed } from "@/lib/outreach/suppression";
import { isSameLocalDay } from "@/lib/outreach/workingHours";
import { requirePlatformCredentials } from "@/lib/platform/credentials";
import { inOrg } from "@/lib/tenancy/scope";
import { lockOrCreateManualRecord } from "./manualTouch";
import { people } from "./schema";

/**
 * One email to one person from the Leads page, through a connected Google
 * Workspace mailbox — no campaign, no sequence.
 *
 * It is held to what a campaign send is held to, so a one-off cannot push a
 * mailbox past its limits: never to Do Not Contact or a suppressed address,
 * only from a connected mailbox, under the mailbox's daily limit and after
 * its sending gap (the same counter and turn the campaign scheduler and the
 * automatic CRM follow-ups use). Sending hours are not applied: those pace
 * automated sending, and a person is pressing Send.
 *
 * Once Gmail has it, the email is the person's first manual touch (or a
 * later one): it goes on their CRM record's email conversation, keyed by the
 * Gmail thread, so a reply lands beside it and later CRM replies thread.
 */

export const MANUAL_EMAIL_EVENT = "manual_email.sent";
export const MAX_SUBJECT_LENGTH = 300;
export const MAX_BODY_LENGTH = 20_000;

export class ManualEmailError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429, message: string) {
    super(message);
    this.name = "ManualEmailError";
  }
}

export type ManualEmailInput = {
  personId: string;
  mailboxId: string;
  subject: string;
  body: string;
  /** Who pressed Send (the user id), for the event. */
  actorRef: string | null;
};

export type ManualEmailResult = {
  /** Null only when Gmail sent it but recording the event failed (logged). */
  eventId: string | null;
  sentAt: string;
  from: string;
  to: string;
  gmailMessageId: string | null;
  threadId: string | null;
};

/** Trimmed subject and body, or a 400. Pure, for the tests. */
export function normalizeManualEmail(input: { subject?: unknown; body?: unknown }): { subject: string; body: string } {
  const subject = typeof input.subject === "string" ? input.subject.replace(/\s+/g, " ").trim() : "";
  const body = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n").trim() : "";
  if (!subject) throw new ManualEmailError(400, "Subject is required");
  if (!body) throw new ManualEmailError(400, "Write a message first");
  if (subject.length > MAX_SUBJECT_LENGTH) throw new ManualEmailError(400, `Subject is too long (at most ${MAX_SUBJECT_LENGTH} characters)`);
  if (body.length > MAX_BODY_LENGTH) throw new ManualEmailError(400, `Message is too long (at most ${MAX_BODY_LENGTH.toLocaleString("en-US")} characters)`);
  return { subject, body };
}

type MailboxState = {
  emailAddress: string;
  status: string;
  dailySendLimit: number;
  todayEmailsSent: number;
  sendCounterResetAt: Date | null;
  nextEmailTime: Date | null;
  workingHours: { timezone: string };
};

/**
 * Whether the mailbox may send now: connected, under its daily limit (a
 * counter last reset on an earlier day counts as zero, as build-queue would
 * reset it), and past its sending gap. Pure, for the tests.
 */
export function mailboxSendVerdict(mailbox: MailboxState, now: Date): { ok: true; countIsStale: boolean } | { ok: false; status: 409 | 429; message: string } {
  if (mailbox.status !== "connected") {
    return { ok: false, status: 409, message: `${mailbox.emailAddress} is not connected — retest it in Settings → Email` };
  }
  const countIsStale = !isSameLocalDay(mailbox.sendCounterResetAt, now, mailbox.workingHours.timezone);
  const sentToday = countIsStale ? 0 : mailbox.todayEmailsSent;
  if (sentToday >= mailbox.dailySendLimit) {
    return { ok: false, status: 429, message: `${mailbox.emailAddress} has sent its ${mailbox.dailySendLimit} emails for today` };
  }
  if (mailbox.nextEmailTime && mailbox.nextEmailTime > now) {
    const minutes = Math.max(1, Math.ceil((mailbox.nextEmailTime.getTime() - now.getTime()) / 60_000));
    return { ok: false, status: 429, message: `${mailbox.emailAddress} sent an email moments ago and waits between sends; it can send again in ${minutes} minute${minutes === 1 ? "" : "s"}` };
  }
  return { ok: true, countIsStale };
}

export async function sendManualEmail(input: ManualEmailInput): Promise<ManualEmailResult> {
  const { subject, body } = normalizeManualEmail(input);

  const [person] = await db.select({ id: people.id, email: people.email }).from(people)
    .where(and(inOrg(people), eq(people.id, input.personId))).limit(1);
  if (!person) throw new ManualEmailError(404, "Person not found");
  if (!person.email) throw new ManualEmailError(400, "This person has no email address — add one with Edit person");
  const to = person.email;

  if (await isPersonDoNotContact(db, person.id) || await isEmailDoNotContact(db, to)) {
    throw new ManualEmailError(409, "This person is marked Do Not Contact");
  }
  if (await isSuppressed(to)) {
    throw new ManualEmailError(409, `${to} is on the suppression list (unsubscribed, bounced or removed by hand)`);
  }

  const [mailbox] = await db.select().from(mailboxes)
    .where(and(inOrg(mailboxes), eq(mailboxes.id, input.mailboxId))).limit(1);
  if (!mailbox) throw new ManualEmailError(404, "Mailbox not found");

  // A Google mailbox needs Google Workspace (PlatformNotConnectedError, which
  // the route answers with 409); an SMTP + IMAP one sends with its own login.
  if (mailbox.provider !== "imap") await requirePlatformCredentials("google");

  const now = new Date();
  const verdict = mailboxSendVerdict(mailbox, now);
  if (!verdict.ok) throw new ManualEmailError(verdict.status, verdict.message);
  if (verdict.countIsStale) {
    // The day's first send: start the counter for today, once, exactly as
    // build-queue does (it compares against the same reset time).
    await db.update(mailboxes)
      .set({ todayEmailsSent: 0, sendCounterResetAt: now })
      .where(and(
        inOrg(mailboxes),
        eq(mailboxes.id, mailbox.id),
        mailbox.sendCounterResetAt ? eq(mailboxes.sendCounterResetAt, mailbox.sendCounterResetAt) : isNull(mailboxes.sendCounterResetAt),
      ));
  }

  // Take the mailbox's turn before sending, so the campaign scheduler or an
  // automatic follow-up cannot send in the same moment; the gap is theirs.
  const { sendGapMinutes } = await channelRules("email");
  const [taken] = await db.update(mailboxes)
    .set({ nextEmailTime: new Date(now.getTime() + pickInRange(sendGapMinutes) * 60_000) })
    .where(and(
      inOrg(mailboxes),
      eq(mailboxes.id, mailbox.id),
      eq(mailboxes.status, "connected"),
      lt(mailboxes.todayEmailsSent, mailboxes.dailySendLimit),
      or(isNull(mailboxes.nextEmailTime), lte(mailboxes.nextEmailTime, now)),
    ))
    .returning({ id: mailboxes.id });
  if (!taken) throw new ManualEmailError(429, `${mailbox.emailAddress} is sending another email right now — try again in a few minutes`);

  const sent = await sendEmail({
    from: mailbox.emailAddress,
    fromName: mailbox.displayName,
    to: [to],
    subject,
    text: body,
    html: toHtmlBody(body) + (mailbox.signatureHtml ? `<br />\n<br />\n${mailbox.signatureHtml}` : ""),
  });
  const sentAt = new Date();

  // Gmail has it: everything below is bookkeeping and must not turn a
  // delivered email into an error the person would retry.
  await db.update(mailboxes)
    .set({ todayEmailsSent: sql`${mailboxes.todayEmailsSent} + 1` })
    .where(and(inOrg(mailboxes), eq(mailboxes.id, mailbox.id)))
    .catch((error) => console.error("[leads/manualEmail] could not count the send against the mailbox:", error));

  const event = await recordSentManualEmail({
    personId: person.id,
    mailbox: { emailAddress: mailbox.emailAddress, displayName: mailbox.displayName },
    to,
    subject,
    body,
    sent,
    sentAt,
    actorRef: input.actorRef,
  });

  return {
    eventId: event?.id ?? null,
    sentAt: sentAt.toISOString(),
    from: mailbox.emailAddress,
    to,
    gmailMessageId: sent.id,
    threadId: sent.threadId,
  };
}

/**
 * What a sent one-off email leaves behind: the person's CRM record (created at
 * this first touch when they have none), the email as an outbound message on
 * the record's email conversation keyed by the Gmail thread — where the reply
 * bridge puts the person's reply, as for a campaign email — and a
 * `manual_email.sent` event. Never throws: if the CRM write fails, the event
 * alone is kept, and if that fails too, null (both logged).
 */
export async function recordSentManualEmail(input: {
  personId: string;
  mailbox: { emailAddress: string; displayName: string | null };
  to: string;
  subject: string;
  body: string;
  sent: { id: string | null; messageId: string | null; threadId: string | null };
  sentAt: Date;
  actorRef: string | null;
}): Promise<{ id: string } | null> {
  const meta = {
    from: input.mailbox.emailAddress,
    to: input.to,
    subject: input.subject,
    body: input.body,
    gmailMessageId: input.sent.id,
    threadId: input.sent.threadId,
    rfcMessageId: input.sent.messageId,
    occurredAt: input.sentAt.toISOString(),
  };
  const actor = { actorType: "human" as const, actorRef: input.actorRef };
  return withCrmTransaction(async (tx) => {
    // The first manual touch gives the person a CRM record, and the email
    // goes on its email conversation keyed by the Gmail thread — where the
    // reply bridge puts the person's reply, as it does for a campaign email.
    const { record } = await lockOrCreateManualRecord(tx, input.personId, actor);
    const { message } = await recordManualOutboundInTransaction(tx, {
      recordId: record.id,
      personId: input.personId,
      channel: "email",
      accountRef: input.mailbox.emailAddress,
      providerThreadId: input.sent.threadId,
      providerContactId: input.to,
      idempotencyKey: `leads-email:${input.sent.id ?? `${input.mailbox.emailAddress}:${input.to}:${input.sentAt.toISOString()}`}`,
      providerMessageId: input.sent.messageId ?? input.sent.id,
      subject: input.subject,
      bodyText: input.body,
      raw: {
        messageId: input.sent.messageId,
        threadId: input.sent.threadId,
        gmailMessageId: input.sent.id,
        from: { email: input.mailbox.emailAddress, name: input.mailbox.displayName },
        to: [{ email: input.to, name: null }],
        subject: input.subject,
      },
      sentAt: input.sentAt,
      reason: "manual_outbound_email",
      ...actor,
      meta: { source: "leads" },
    });
    return appendCrmEvent(tx, {
      personId: input.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: MANUAL_EMAIL_EVENT,
      ...actor,
      meta: { ...meta, messageId: message.id },
      contextVersion: record.contextVersion,
      createdAt: input.sentAt,
    });
  }).catch(async (error) => {
    // Keep at least the fact of the send on the person.
    console.error("[leads/manualEmail] email sent but the CRM record was not updated:", error);
    return withCrmTransaction((tx) => appendCrmEvent(tx, { personId: input.personId, eventType: MANUAL_EMAIL_EVENT, ...actor, meta, createdAt: input.sentAt }))
      .catch((fallbackError) => {
        console.error("[leads/manualEmail] email sent but its event was not recorded either:", fallbackError);
        return null;
      });
  });
}
