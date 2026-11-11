/**
 * Reply sync for SMTP + IMAP mailboxes. IMAP has no push like Gmail's
 * Pub/Sub watch, so the platform job `email-imap-sync` polls every connected
 * IMAP mailbox's INBOX every two minutes and feeds each new message through
 * the same reply bridge as Gmail (Master Inbox, CRM, bounces, sequences stop).
 *
 * The cursor (`imap_cursor`: UIDVALIDITY and the last UID read) advances one
 * message at a time, only past messages that were stored, so a failure is
 * retried on the next poll. A message that keeps failing is given up after
 * MAX_ATTEMPTS polls (its event stays in the inbound log, unprocessed) so one
 * bad message cannot stop a mailbox's replies for good.
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { createStepLogger } from "@/lib/debugLog";
import { crmConversations } from "@/lib/crm/schema";
import { inboundEvents } from "@/lib/inbox/schema";
import { isPeopleMigrationMode } from "@/lib/migration/controls";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import type { InboundMessage } from "./gmail";
import { fetchNewImapMessages, loadImapSmtpLogin, mailServerErrorMessage, type ImapFetchResult } from "./imapSmtp";
import { ingestGmailReply } from "./replyBridge";
import { mailboxes, outreachEmails, type ImapCursor } from "./schema";

/** Polls a failing message is retried before sync moves past it. */
export const MAX_ATTEMPTS = 5;

/** Messages read per mailbox per poll; the rest wait for the next one. */
const BATCH = 25;

/** Mailboxes polled at once across the platform. */
const CONCURRENCY = 4;

type SyncOptions = {
  fetch?: (cursor: ImapCursor) => Promise<ImapFetchResult>;
  ingest?: typeof ingestGmailReply;
  findThread?: (mailboxAddress: string, candidates: string[]) => Promise<string | null>;
};

export type ImapSyncResult = { synced: number; skipped?: string; error?: string; more?: boolean };

/**
 * The thread a reply belongs to, when one of the ids it references is a
 * thread we already hold: a CRM conversation's thread on this mailbox, or a
 * campaign email we sent. Covers clients that drop the root from References.
 */
async function findKnownThread(mailboxAddress: string, candidates: string[]): Promise<string | null> {
  if (candidates.length === 0) return null;
  const [conversation] = await db
    .select({ threadId: crmConversations.providerThreadId })
    .from(crmConversations)
    .where(and(
      inOrg(crmConversations),
      eq(crmConversations.channel, "email"),
      eq(crmConversations.accountRef, mailboxAddress),
      inArray(crmConversations.providerThreadId, candidates),
    ))
    .limit(1);
  if (conversation?.threadId) return conversation.threadId;
  const [sent] = await db
    .select({ threadId: outreachEmails.threadId })
    .from(outreachEmails)
    .innerJoin(mailboxes, eq(mailboxes.id, outreachEmails.mailboxId))
    .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, mailboxAddress), inArray(outreachEmails.messageId, candidates)))
    .limit(1);
  return sent?.threadId ?? null;
}

async function saveCursor(mailboxId: string, cursor: ImapCursor, lastError: string | null) {
  await db
    .update(mailboxes)
    .set({ imapCursor: cursor, lastError })
    .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
}

async function logEvent(msg: InboundMessage, log: ReturnType<typeof createStepLogger>, processed: boolean, error?: string) {
  await db.insert(inboundEvents).values({
    organizationId: currentOrganizationId(),
    source: "imap",
    eventType: "inbound_message",
    title: msg.fromName || msg.fromEmail || null,
    status: log.status,
    steps: log.steps,
    payload: msg as unknown as object,
    processed,
    ...(error ? { error } : {}),
  });
}

/** Syncs one IMAP mailbox of the current organization. */
export async function syncImapMailbox(mailboxId: string, options: SyncOptions = {}): Promise<ImapSyncResult> {
  const [mailbox] = await db.select().from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId))).limit(1);
  if (!mailbox || mailbox.provider !== "imap" || mailbox.status !== "connected") return { synced: 0, skipped: "not_connected" };
  // Set by the connection test; without it there is no "since" to read from.
  if (!mailbox.imapCursor) return { synced: 0, skipped: "no_cursor" };
  const cursor = mailbox.imapCursor;

  let fetched: ImapFetchResult;
  try {
    if (options.fetch) {
      fetched = await options.fetch(cursor);
    } else {
      const login = await loadImapSmtpLogin(mailbox.id);
      if (!login) return { synced: 0, skipped: "no_login" };
      fetched = await fetchNewImapMessages(login, cursor, BATCH);
    }
  } catch (err) {
    const message = `reply sync failed: ${mailServerErrorMessage(err)}`;
    await db.update(mailboxes).set({ lastError: message }).where(and(inOrg(mailboxes), eq(mailboxes.id, mailbox.id)));
    return { synced: 0, error: message };
  }

  if (fetched.reset) {
    // The server renumbered INBOX: UIDs from before mean nothing now. Start
    // from its current end, as Gmail does after a stale history cursor.
    await saveCursor(mailbox.id, fetched.cursor, "The mail server renumbered INBOX — reply sync restarted from now; mail received since the last sync was not read");
    return { synced: 0, error: "uidvalidity_changed" };
  }

  let position: ImapCursor = { uidValidity: cursor.uidValidity, lastUid: cursor.lastUid };
  let synced = 0;
  let skippedNote: string | null = null;
  for (const { uid, message, references } of fetched.messages) {
    const log = createStepLogger();
    log.info(`IMAP inbound message ${message.gmailMessageId} (UID ${uid}) — processing`);
    const msg: InboundMessage = { ...message };
    try {
      const candidates = [...new Set([...references, ...(msg.inReplyTo ? [msg.inReplyTo] : [])])];
      const known = await (options.findThread ?? findKnownThread)(mailbox.emailAddress, candidates);
      if (known) msg.threadId = known;
      const result = await (options.ingest ?? ingestGmailReply)(mailbox.emailAddress, msg, log);
      log.finish(result.skipped ? "skipped" : "ok");
      await logEvent(msg, log, true);
      if (!result.skipped) synced += 1;
      position = { uidValidity: cursor.uidValidity, lastUid: uid };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(error);
      log.finish("error");
      await logEvent(msg, log, false, error).catch((logError) => console.error("[outreach/imapSync] could not log the failed message:", logError));
      const attempts = cursor.retryUid === uid ? (cursor.retries ?? 0) + 1 : 1;
      if (attempts < MAX_ATTEMPTS) {
        // Stop here: everything before it is stored, it and the rest are read again next poll.
        await saveCursor(mailbox.id, { ...position, retryUid: uid, retries: attempts }, `reply sync: message ${message.gmailMessageId} failed (attempt ${attempts} of ${MAX_ATTEMPTS}): ${error}`);
        return { synced, error };
      }
      // Given up: move past it so later replies still arrive. The event above keeps it on record.
      position = { uidValidity: cursor.uidValidity, lastUid: uid };
      skippedNote = `reply sync skipped message ${message.gmailMessageId} after ${MAX_ATTEMPTS} failed attempts: ${error}`;
    }
  }

  const moved = position.lastUid !== cursor.lastUid || cursor.retryUid !== undefined;
  // A poll that reached the server clears an earlier connection error.
  const staleError = Boolean(mailbox.lastError?.startsWith("reply sync"));
  if (moved || skippedNote || staleError) await saveCursor(mailbox.id, position, skippedNote);
  return { synced, more: fetched.more };
}

/**
 * The platform job: every connected IMAP mailbox of every organization, each
 * in its organization's scope, a few at a time. Paused in PEOPLE_MIGRATION_MODE,
 * since ingesting a reply writes People and CRM rows.
 */
export async function pollImapMailboxes(): Promise<{ mailboxes: number; synced: number; failed: number; paused?: boolean }> {
  if (isPeopleMigrationMode()) return { mailboxes: 0, synced: 0, failed: 0, paused: true };
  const rows = await db
    .select({ id: mailboxes.id, organizationId: mailboxes.organizationId, emailAddress: mailboxes.emailAddress })
    .from(mailboxes)
    .where(and(eq(mailboxes.provider, "imap"), eq(mailboxes.status, "connected")));

  const summary = { mailboxes: rows.length, synced: 0, failed: 0 };
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        const result = await runInOrganization(row.organizationId, () => syncImapMailbox(row.id));
        summary.synced += result.synced;
        if (result.error) summary.failed += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(`[outreach/imapSync] ${row.emailAddress} failed:`, err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  return summary;
}
