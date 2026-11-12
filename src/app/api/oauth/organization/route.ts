import { NextRequest, NextResponse } from "next/server";
import { isMemberOf } from "@/lib/auth/oauthProvider";
import {
  OAUTH_ORGANIZATION_COOKIE,
  OAUTH_ORGANIZATION_COOKIE_MAX_AGE,
  organizationChoiceValue,
} from "@/lib/auth/oauthOrganizationChoice";
import { auth } from "@/lib/auth/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/oauth/organization, body { organizationId }: the choice on
// /oauth/organization. Makes it the session's active organization (which the
// consent and its tokens are tied to) and records the choice, so the OAuth
// authorization continues past the picker (src/lib/auth/oauthOrganizationChoice.ts).
//
// Switching here, on the server, and not with the browser's
// organization.setActive: on the picker page the OAuth client plugin adds the
// signed query to every POST, and a POST that re-sets the session cookie
// re-runs the authorization at once, before the choice is recorded, which
// sends the person straight back to the picker.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.json({ error: "Sign in to continue" }, { status: 401 });
  const body: unknown = await req.json().catch(() => null);
  const organizationId = body && typeof body === "object" && "organizationId" in body ? (body as { organizationId: unknown }).organizationId : null;
  if (typeof organizationId !== "string" || !UUID.test(organizationId) || !(await isMemberOf(session.user.id, organizationId))) {
    return NextResponse.json({ error: "Choose an organization you are a member of" }, { status: 403 });
  }

  const switched = await auth.api.setActiveOrganization({ headers: req.headers, body: { organizationId }, returnHeaders: true });
  const response = NextResponse.json({ ok: true });
  // The refreshed session cookies, so the next request reads the new active organization.
  for (const cookie of switched.headers.getSetCookie()) response.headers.append("set-cookie", cookie);
  response.cookies.set(OAUTH_ORGANIZATION_COOKIE, organizationChoiceValue(session.session.id, organizationId), {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(req.url).protocol === "https:",
    path: "/",
    maxAge: OAUTH_ORGANIZATION_COOKIE_MAX_AGE,
  });
  return response;
}
