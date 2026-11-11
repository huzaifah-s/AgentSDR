import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxes } from "@/lib/outreach/schema";
import { registerWatch } from "@/lib/outreach/gmail";
import { getPlatformCredentials } from "@/lib/platform/credentials";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";

export type MailboxWatchResult = {
  results: { emailAddress: string; ok: boolean; error?: string }[];
  skipped: { organizationId: string; reason: string }[];
};

/**
 * (Re)registers Gmail Pub/Sub push notifications for every connected mailbox,
 * or only those of `organizationIds`. Watches expire after ~7 days, so this
 * runs daily: in each organization's daily rollover, or from
 * /api/outreach/mailboxes/watch.
 *
 * No session: the connected mailboxes are grouped by organization and each
 * organization's watches are renewed in its own scope. Google is connected per
 * organization, so one without it is skipped rather than failing the run.
 */
export async function renewMailboxWatches(options: { organizationIds?: string[] } = {}): Promise<MailboxWatchResult> {
  // Only Google mailboxes have Gmail watches; SMTP + IMAP ones are polled (imapSync.ts).
  const connected = await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.status, "connected"), eq(mailboxes.provider, "google")));
  const wanted = options.organizationIds ? new Set(options.organizationIds) : null;
  const byOrganization = new Map<string, (typeof connected)[number][]>();
  for (const mailbox of connected) {
    if (wanted && !wanted.has(mailbox.organizationId)) continue;
    byOrganization.set(mailbox.organizationId, [...(byOrganization.get(mailbox.organizationId) ?? []), mailbox]);
  }

  const results: MailboxWatchResult["results"] = [];
  const skipped: MailboxWatchResult["skipped"] = [];

  for (const [organizationId, organizationMailboxes] of byOrganization) {
    await runInOrganization(organizationId, async () => {
      const google = await getPlatformCredentials("google");
      if (!google) {
        console.log(`[outreach/watch] Google Workspace is not connected for organization ${organizationId}; watch renewal skipped`);
        skipped.push({ organizationId, reason: "google_not_connected" });
        return;
      }
      const topic = google.gmailWatchTopic;
      if (!topic) {
        skipped.push({ organizationId, reason: "gmail_watch_topic_not_configured" });
        return;
      }
      for (const mailbox of organizationMailboxes) {
        const result = await registerWatch(mailbox.emailAddress, topic);
        if (result.ok) {
          await db
            .update(mailboxes)
            .set({ lastHistoryId: result.historyId ?? mailbox.lastHistoryId })
            .where(and(inOrg(mailboxes), eq(mailboxes.id, mailbox.id)));
          results.push({ emailAddress: mailbox.emailAddress, ok: true });
        } else {
          results.push({ emailAddress: mailbox.emailAddress, ok: false, error: result.error });
        }
      }
    });
  }

  return { results, skipped };
}
