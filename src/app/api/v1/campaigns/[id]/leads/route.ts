import { NextRequest, NextResponse } from "next/server";
import { jsonBody, withApiKey } from "@/lib/publicApi/http";
import { campaignIdParam } from "@/lib/publicApi/requests";
import { addLeads } from "@/lib/publicApi/operations";

// POST /api/v1/campaigns/:id/leads: body { leads: [...] } (src/lib/publicApi/requests.ts).
// Same rules as a sheet import: suppressed addresses and leads already in the
// campaign are skipped, extra fields become merge fields. Returns
// { total, imported, skippedSuppressed, skippedDuplicate, failed: [{ index, email, error }] }.
// The MCP tool add_leads_to_campaign is the same operation.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiKey(req, async () => {
    // The id is checked before the body is read, so a bad id is a 404 whatever the body.
    const id = campaignIdParam((await params).id);
    return NextResponse.json(await addLeads(id, await jsonBody(req)));
  });
}
