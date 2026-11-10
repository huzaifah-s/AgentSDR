import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { outreachCampaigns } from "@/lib/outreach/schema";
import { withApiKey } from "@/lib/publicApi/http";
import { inOrg } from "@/lib/tenancy/scope";

// GET /api/v1/campaigns: the organization's email campaigns, newest first:
// { campaigns: [{ id, name, status, createdAt }] }. Authorized by API key.
export async function GET(req: NextRequest) {
  return withApiKey(req, async () => {
    const rows = await db
      .select({ id: outreachCampaigns.id, name: outreachCampaigns.name, status: outreachCampaigns.status, createdAt: outreachCampaigns.createdAt })
      .from(outreachCampaigns)
      .where(inOrg(outreachCampaigns))
      .orderBy(desc(outreachCampaigns.createdAt));
    return NextResponse.json({
      campaigns: rows.map((row) => ({ ...row, createdAt: row.createdAt?.toISOString() ?? null })),
    });
  });
}
