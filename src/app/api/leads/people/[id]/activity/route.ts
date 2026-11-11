import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { assertSameOriginMutation, CrmRequestError } from "@/lib/crm/http";
import { listPersonActivity } from "@/lib/leads/personActivity";
import { logManualActivity, ManualTouchError, normalizeLoggedUpdate } from "@/lib/leads/manualTouch";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Person not found" }, { status: 404 });

async function withAuth(req: NextRequest, fn: Parameters<typeof withOrgContext<NextResponse>>[1]) {
  try {
    return await withOrgContext(req, fn);
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}

/** GET /api/leads/people/[id]/activity — the person drawer's Activity list (CRM events). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) return notFound();
  return withAuth(req, async () => {
    const events = await listPersonActivity(id);
    return events ? NextResponse.json({ events }) : notFound();
  });
}

/**
 * POST /api/leads/people/[id]/activity — Log an update: { kind, direction,
 * occurredAt?, summary, followUpAt? }. Kept as an `activity.logged` event on
 * the person's CRM record, which this first manual touch creates when they
 * have none. `followUp` says whether a follow-up date went on the record.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    assertSameOriginMutation(req);
  } catch (error) {
    if (error instanceof CrmRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  if (!UUID_SHAPE.test(id)) return notFound();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body is required" }, { status: 400 });
  return withAuth(req, async (ctx) => {
    try {
      const update = normalizeLoggedUpdate(body, new Date());
      return NextResponse.json(await logManualActivity({ personId: id, update, actorRef: ctx.userEmail }), { status: 201 });
    } catch (error) {
      if (error instanceof ManualTouchError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  });
}
