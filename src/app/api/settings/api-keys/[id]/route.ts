import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";
import { revokeApiKey } from "@/lib/publicApi/keys";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DELETE /api/settings/api-keys/:id: revokes the key at once. The row stays,
// so Settings can still show when it was last used.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "API key not found" }, { status: 404 });
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      if (!(await revokeApiKey(id))) return NextResponse.json({ error: "API key not found" }, { status: 404 });
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    const denied = authContextErrorResponse(error);
    if (denied) return denied;
    throw error;
  }
}
