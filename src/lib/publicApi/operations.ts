import "server-only";

import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { CRM_ACTION_GROUP_LABELS, type CrmActionGroup } from "@/lib/crm/actionGroups";
import { listCrmActions } from "@/lib/crm/queries";
import { getCampaign, getCampaignStats } from "@/lib/outreach/campaigns";
import { importRowsForCampaign } from "@/lib/outreach/leadImport";
import { campaignLeadStatuses, type CampaignLeadStatus } from "@/lib/outreach/leadStatus";
import { outreachCampaigns } from "@/lib/outreach/schema";
import { stopCampaignLeads, type StopLeadsResult } from "@/lib/outreach/stopLeads";
import { inOrg } from "@/lib/tenancy/scope";
import {
  PublicApiError,
  assertCampaignWritesAllowed,
  campaignIdParam,
  parseActionRequiredQuery,
  parseLeadsRequest,
  parseLookupEmails,
  parseStopRequest,
} from "./requests";

/**
 * What the public API does, shared by both of its front doors: the REST
 * routes under /api/v1/campaigns and the MCP tools at /api/v1/mcp
 * (src/lib/publicApi/mcp.ts). Each runs inside the organization scope that
 * withApiKey opened, returns the response body, and throws PublicApiError
 * for anything the caller got wrong. A new operation goes here, and gets its
 * route and its tool in the same change.
 */

export type CampaignSummary = { id: string; name: string; status: string; createdAt: string | null };
export type ListCampaignsResult = { campaigns: CampaignSummary[] };

export type AddLeadsResult = {
  total: number;
  imported: number;
  skippedSuppressed: number;
  skippedDuplicate: number;
  failed: { index: number; email: string; error: string }[];
};

export type { StopLeadsResult };

export type CampaignDetail = CampaignSummary & {
  /** Steps in the sequence: the first email and its follow-ups. */
  steps: number;
  leads: {
    total: number;
    /** Not emailed yet. */
    pending: number;
    /** Emailed, with steps still to go. */
    inSequence: number;
    replied: number;
    /** Every step sent, or stopped. */
    completed: number;
    bounced: number;
    suppressed: number;
  };
  emails: { sent: number; scheduled: number; failed: number };
};

export type CampaignLeadsResult = { leads: CampaignLeadStatus[]; notFound: string[] };

export type ActionRequiredItem = {
  recordId: string;
  person: { name: string | null; email: string | null; company: string | null };
  channel: string | null;
  /** What the queue says to do, e.g. "Reply review", "Due follow-up". */
  action: string;
  group: CrmActionGroup | null;
  groupLabel: string | null;
  dueAt: string | null;
  category: string | null;
  latestReply: { at: string | null; excerpt: string } | null;
  draft: { status: string; channel: string; subject: string | null } | null;
};

export type ActionRequiredResult = {
  items: ActionRequiredItem[];
  total: number;
  limit: number;
  offset: number;
  /** The offset of the next page, or null on the last one. */
  nextOffset: number | null;
};

/** The organization's email campaigns, newest first. */
export async function listCampaigns(): Promise<ListCampaignsResult> {
  const rows = await db
    .select({ id: outreachCampaigns.id, name: outreachCampaigns.name, status: outreachCampaigns.status, createdAt: outreachCampaigns.createdAt })
    .from(outreachCampaigns)
    .where(inOrg(outreachCampaigns))
    .orderBy(desc(outreachCampaigns.createdAt));
  return { campaigns: rows.map((row) => ({ ...row, createdAt: row.createdAt?.toISOString() ?? null })) };
}

/** One campaign with its numbers. Another organization's id is "Campaign not found". */
export async function getCampaignDetail(campaignId: string): Promise<CampaignDetail> {
  const id = campaignIdParam(campaignId);
  const campaign = await getCampaign(id);
  if (!campaign) throw new PublicApiError(404, "Campaign not found");
  const stats = await getCampaignStats(id);
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    createdAt: campaign.createdAt?.toISOString() ?? null,
    steps: campaign.sequence.length,
    leads: {
      total: stats.totalLeads,
      pending: stats.pending,
      inSequence: stats.inSequence,
      replied: stats.replied,
      completed: stats.completed,
      bounced: stats.bounced,
      suppressed: stats.suppressed,
    },
    emails: { sent: stats.emailsSent, scheduled: stats.emailsScheduled, failed: stats.emailsFailed },
  };
}

/** Where these addresses stand in a campaign (src/lib/outreach/leadStatus.ts). */
export async function getCampaignLeads(campaignId: string, emails: unknown): Promise<CampaignLeadsResult> {
  const id = campaignIdParam(campaignId);
  const result = await campaignLeadStatuses(id, parseLookupEmails(emails));
  if (!result) throw new PublicApiError(404, "Campaign not found");
  return result;
}

/**
 * The CRM's Action required queue, newest activity first, as the CRM page
 * lists it (listCrmActions), cut down to what a caller needs to decide what
 * to look at: who, which channel, what to do, and the reply's first lines.
 */
export async function listActionRequired(query: { group?: unknown; limit?: unknown; offset?: unknown }): Promise<ActionRequiredResult> {
  const { group, limit, offset } = parseActionRequiredQuery(query);
  const page = await listCrmActions({ scope: "actions", actionGroup: group, limit, offset });
  return {
    items: page.actions.map((row): ActionRequiredItem => {
      const person = row.person;
      const name = person.fullName || [person.firstName, person.lastName].filter(Boolean).join(" ") || null;
      const rowGroup = row.actionGroup ?? null;
      return {
        recordId: row.recordId,
        person: { name, email: person.email ?? null, company: row.company?.name ?? null },
        channel: row.channel ?? null,
        action: row.actionType,
        group: rowGroup,
        groupLabel: rowGroup ? CRM_ACTION_GROUP_LABELS[rowGroup] : null,
        dueAt: row.dueAt?.toISOString() ?? null,
        category: row.category ?? null,
        latestReply: row.latestInbound ? { at: row.latestInbound.sentAt?.toISOString() ?? null, excerpt: row.latestInboundExcerpt } : null,
        draft: row.draft ? { status: row.draft.status, channel: row.draft.channel, subject: row.draft.subject ?? null } : null,
      };
    }),
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    nextOffset: page.hasMore ? page.nextOffset : null,
  };
}

/**
 * `{ leads: [...] }` into a campaign, with a sheet import's rules: suppressed
 * addresses and leads already in the campaign are skipped, extra fields
 * become merge fields (src/lib/publicApi/requests.ts).
 */
export async function addLeads(campaignId: string, body: unknown): Promise<AddLeadsResult> {
  assertCampaignWritesAllowed();
  const id = campaignIdParam(campaignId);
  const rows = parseLeadsRequest(body);
  const result = await importRowsForCampaign(id, rows, {
    source: "api",
    filename: null,
    mapping: { mode: "api", fields: "named", extra: "people.raw" },
    firstRow: 0,
  });
  if ("error" in result) throw new PublicApiError(result.error === "Campaign not found" ? 404 : 400, result.error);
  const { failed, ...counts } = result;
  return { ...counts, failed: failed.map(({ row, ...rest }) => ({ index: row, ...rest })) };
}

/** `{ emails: [...] }`: ends those leads' sequence without suppressing them. Idempotent. */
export async function stopLeads(campaignId: string, body: unknown): Promise<StopLeadsResult> {
  assertCampaignWritesAllowed();
  const id = campaignIdParam(campaignId);
  const result = await stopCampaignLeads(id, parseStopRequest(body));
  if (!result) throw new PublicApiError(404, "Campaign not found");
  return result;
}
