import "server-only";

import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { importRowsForCampaign } from "@/lib/outreach/leadImport";
import { outreachCampaigns } from "@/lib/outreach/schema";
import { stopCampaignLeads, type StopLeadsResult } from "@/lib/outreach/stopLeads";
import { inOrg } from "@/lib/tenancy/scope";
import { PublicApiError, assertCampaignWritesAllowed, campaignIdParam, parseLeadsRequest, parseStopRequest } from "./requests";

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

/** The organization's email campaigns, newest first. */
export async function listCampaigns(): Promise<ListCampaignsResult> {
  const rows = await db
    .select({ id: outreachCampaigns.id, name: outreachCampaigns.name, status: outreachCampaigns.status, createdAt: outreachCampaigns.createdAt })
    .from(outreachCampaigns)
    .where(inOrg(outreachCampaigns))
    .orderBy(desc(outreachCampaigns.createdAt));
  return { campaigns: rows.map((row) => ({ ...row, createdAt: row.createdAt?.toISOString() ?? null })) };
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
