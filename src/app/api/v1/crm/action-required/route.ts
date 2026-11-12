import { NextRequest, NextResponse } from "next/server";
import { withApiKey } from "@/lib/publicApi/http";
import { listActionRequired } from "@/lib/publicApi/operations";

// GET /api/v1/crm/action-required?group=&limit=&offset=: the CRM's Action
// required queue, newest activity first. `group` is reply, follow_up,
// classification, next_step or problem; `limit` 1 to 50 (default 20).
// { items: [...], total, limit, offset, nextOffset }.
// The MCP tool list_action_required is the same operation.
export async function GET(req: NextRequest) {
  return withApiKey(req, async () => {
    const query = req.nextUrl.searchParams;
    return NextResponse.json(await listActionRequired({
      group: query.get("group") ?? undefined,
      limit: query.get("limit") ?? undefined,
      offset: query.get("offset") ?? undefined,
    }));
  }, { scope: "crm:read" });
}
