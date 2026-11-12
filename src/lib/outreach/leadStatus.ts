import "server-only";

import { and, count, eq, inArray, max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { people } from "@/lib/leads/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { leadsInOrg } from "./orgScope";
import { outreachCampaigns, outreachEmails, outreachLeads, type OutreachLeadStatus } from "./schema";

export type CampaignLeadStatus = {
  email: string;
  status: OutreachLeadStatus;
  /** Emails of this campaign that have gone out to them. */
  emailsSent: number;
  lastSentAt: string | null;
  /** When the next step is due; null when none is scheduled. */
  nextSendAt: string | null;
  addedAt: string | null;
};

/**
 * Where these addresses stand in one campaign: the public API's "is this
 * person still being emailed?" (src/lib/publicApi/operations.ts). Matched
 * case-insensitively, like a stop. Runs inside an organization scope; another
 * organization's campaign is null.
 */
export async function campaignLeadStatuses(
  campaignId: string,
  emails: string[],
): Promise<{ leads: CampaignLeadStatus[]; notFound: string[] } | null> {
  const [campaign] = await db
    .select({ id: outreachCampaigns.id })
    .from(outreachCampaigns)
    .where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, campaignId)))
    .limit(1);
  if (!campaign) return null;

  const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()))];
  if (wanted.length === 0) return { leads: [], notFound: [] };

  const rows = await db
    .select({
      id: outreachLeads.id,
      email: sql<string>`lower(${people.email})`,
      status: outreachLeads.sequenceStatus,
      nextSendAt: outreachLeads.nextSendAt,
      addedAt: outreachLeads.createdAt,
    })
    .from(outreachLeads)
    .innerJoin(people, eq(outreachLeads.personId, people.id))
    .where(and(leadsInOrg(), inOrg(people), eq(outreachLeads.campaignId, campaignId), inArray(sql`lower(${people.email})`, wanted)));

  const sends = rows.length
    ? await db
        .select({ leadId: outreachEmails.leadId, sent: count(), lastSentAt: max(outreachEmails.sentAt) })
        .from(outreachEmails)
        .where(and(inArray(outreachEmails.leadId, rows.map((row) => row.id)), eq(outreachEmails.status, "sent")))
        .groupBy(outreachEmails.leadId)
    : [];
  const sendsByLead = new Map(sends.map((row) => [row.leadId, row]));

  const leads = rows.map((row): CampaignLeadStatus => {
    const sent = sendsByLead.get(row.id);
    return {
      email: row.email,
      status: row.status,
      emailsSent: sent?.sent ?? 0,
      lastSentAt: sent?.lastSentAt ? new Date(sent.lastSentAt).toISOString() : null,
      nextSendAt: row.nextSendAt?.toISOString() ?? null,
      addedAt: row.addedAt?.toISOString() ?? null,
    };
  });
  const found = new Set(leads.map((lead) => lead.email));
  return { leads, notFound: wanted.filter((email) => !found.has(email)) };
}
