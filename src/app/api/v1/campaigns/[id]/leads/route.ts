import { NextRequest, NextResponse } from "next/server";
import { importRowsForCampaign } from "@/lib/outreach/leadImport";
import { campaignIdParam, jsonBody, withApiKey } from "@/lib/publicApi/http";
import { PublicApiError, parseLeadsRequest } from "@/lib/publicApi/requests";

// POST /api/v1/campaigns/:id/leads: body { leads: [...] } (src/lib/publicApi/requests.ts).
// Same rules as a sheet import: suppressed addresses and leads already in the
// campaign are skipped, extra fields become merge fields. Returns
// { total, imported, skippedSuppressed, skippedDuplicate, failed: [{ index, email, error }] }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiKey(req, async () => {
    const campaignId = campaignIdParam((await params).id);
    const rows = parseLeadsRequest(await jsonBody(req));
    const result = await importRowsForCampaign(campaignId, rows, {
      source: "api",
      filename: null,
      mapping: { mode: "api", fields: "named", extra: "people.raw" },
      firstRow: 0,
    });
    if ("error" in result) throw new PublicApiError(result.error === "Campaign not found" ? 404 : 400, result.error);
    const { failed, ...counts } = result;
    return NextResponse.json({ ...counts, failed: failed.map(({ row, ...rest }) => ({ index: row, ...rest })) });
  });
}
