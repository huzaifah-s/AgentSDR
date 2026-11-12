import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, requireOrgContext } from "@/lib/auth/context";
import { disconnectApp } from "@/lib/auth/connectedApps";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DELETE /api/settings/connected-apps/:id: disconnects one of the signed-in
// person's OAuth apps: the consent goes and the app's tokens for them are
// revoked at once (src/lib/auth/connectedApps.ts). A person's own apps only.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Connected app not found" }, { status: 404 });
  try {
    const ctx = await requireOrgContext(req);
    if (!(await disconnectApp(ctx.userId, id))) return NextResponse.json({ error: "Connected app not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const denied = authContextErrorResponse(error);
    if (denied) return denied;
    throw error;
  }
}
