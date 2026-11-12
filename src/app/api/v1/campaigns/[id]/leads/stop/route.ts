import { NextRequest, NextResponse } from "next/server";
import { jsonBody, withApiKey } from "@/lib/publicApi/http";
import { campaignIdParam } from "@/lib/publicApi/requests";
import { stopLeads } from "@/lib/publicApi/operations";

// POST /api/v1/campaigns/:id/leads/stop: body { emails: [...] }. Ends the
// sequence for those leads without suppressing them (src/lib/outreach/stopLeads.ts).
// Idempotent. Returns { stopped, alreadyEnded, notFound: [email] }.
// The MCP tool stop_campaign_leads is the same operation.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiKey(req, async () => {
    // The id is checked before the body is read, so a bad id is a 404 whatever the body.
    const id = campaignIdParam((await params).id);
    return NextResponse.json(await stopLeads(id, await jsonBody(req)));
  }, { scope: "campaigns:write" });
}
