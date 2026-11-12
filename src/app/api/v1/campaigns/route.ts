import { NextRequest, NextResponse } from "next/server";
import { withApiKey } from "@/lib/publicApi/http";
import { listCampaigns } from "@/lib/publicApi/operations";

// GET /api/v1/campaigns: the organization's email campaigns, newest first:
// { campaigns: [{ id, name, status, createdAt }] }. Authorized by API key.
// The MCP tool list_campaigns is the same operation.
export async function GET(req: NextRequest) {
  return withApiKey(req, async () => NextResponse.json(await listCampaigns()));
}
