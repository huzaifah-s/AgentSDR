import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";
import { createApiKey, listApiKeys } from "@/lib/publicApi/keys";

// API keys for the public API (Settings → API keys). An API key acts for the
// whole organization, so listing and managing keys takes the integrations
// permission (owners, admins), like the integrations themselves.

function failure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status: 400 });
}

// GET /api/settings/api-keys: { keys: ApiKeySummary[] }
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      return NextResponse.json({ keys: await listApiKeys() });
    });
  } catch (error) {
    return failure(error, "Could not load the API keys");
  }
}

// POST /api/settings/api-keys: body { name }; returns { key, apiKey }. `key` is shown once.
export async function POST(req: NextRequest) {
  const body: unknown = await req.json().catch(() => null);
  const name = body && typeof body === "object" && "name" in body && typeof body.name === "string" ? body.name : "";
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      return NextResponse.json(await createApiKey(name, ctx.userId), { status: 201 });
    });
  } catch (error) {
    return failure(error, "Could not create the API key");
  }
}
