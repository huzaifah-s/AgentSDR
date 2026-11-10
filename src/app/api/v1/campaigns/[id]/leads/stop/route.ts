import { NextRequest, NextResponse } from "next/server";
import { stopCampaignLeads } from "@/lib/outreach/stopLeads";
import { campaignIdParam, jsonBody, withApiKey } from "@/lib/publicApi/http";
import { PublicApiError, parseStopRequest } from "@/lib/publicApi/requests";

// POST /api/v1/campaigns/:id/leads/stop: body { emails: [...] }. Ends the
// sequence for those leads without suppressing them (src/lib/outreach/stopLeads.ts).
// Idempotent. Returns { stopped, alreadyEnded, notFound: [email] }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiKey(req, async () => {
    const campaignId = campaignIdParam((await params).id);
    const result = await stopCampaignLeads(campaignId, parseStopRequest(await jsonBody(req)));
    if (!result) throw new PublicApiError(404, "Campaign not found");
    return NextResponse.json(result);
  });
}
