import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";
import { isApiKeyAccess } from "@/lib/publicApi/access";
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

// POST /api/settings/api-keys: body { name, access? }; returns { key, apiKey }. `key` is shown once.
// `access` is "read_write" (the default) or "read" (src/lib/publicApi/access.ts).
export async function POST(req: NextRequest) {
  const body: unknown = await req.json().catch(() => null);
  const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name = typeof fields.name === "string" ? fields.name : "";
  const access = fields.access === undefined ? "read_write" : fields.access;
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      if (!isApiKeyAccess(access)) return NextResponse.json({ error: "access must be read_write or read" }, { status: 400 });
      return NextResponse.json(await createApiKey(name, ctx.userId, access), { status: 201 });
    });
  } catch (error) {
    return failure(error, "Could not create the API key");
  }
}
