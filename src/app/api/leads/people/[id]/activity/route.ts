import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { listPersonActivity } from "@/lib/leads/personActivity";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/leads/people/[id]/activity — the person drawer's Activity list (CRM events). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) return NextResponse.json({ error: "Person not found" }, { status: 404 });
  try {
    return await withOrgContext(req, async () => {
      const events = await listPersonActivity(id);
      if (!events) return NextResponse.json({ error: "Person not found" }, { status: 404 });
      return NextResponse.json({ events });
    });
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}
