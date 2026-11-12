import { NextRequest, NextResponse } from "next/server";
import { withApiKey } from "@/lib/publicApi/http";
import { getCampaignDetail } from "@/lib/publicApi/operations";

// GET /api/v1/campaigns/:id: one campaign with its numbers:
// { id, name, status, createdAt, steps, leads: { total, pending, inSequence,
// replied, completed, bounced, suppressed }, emails: { sent, scheduled, failed } }.
// The MCP tool get_campaign is the same operation.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiKey(req, async () => NextResponse.json(await getCampaignDetail((await params).id)), { scope: "campaigns:read" });
}
