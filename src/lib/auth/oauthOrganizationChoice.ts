/**
 * Remembering, for one OAuth authorization, that a member of several
 * organizations has chosen one (/oauth/organization). The plugin's postLogin
 * step ends only when our shouldRedirect says the choice is made
 * (src/lib/auth/oauthProvider.ts), and the choice lives here: a cookie naming
 * the session and the organization, set right after the session's active
 * organization was switched to it, good for ten minutes.
 *
 * It carries no authority. Forging it only skips the picker, so the
 * authorization uses the session's active organization, whose membership is
 * checked at consent and on every request. Pure, so it is tested on its own.
 */

export const OAUTH_ORGANIZATION_COOKIE = "bsdr_oauth_org";
export const OAUTH_ORGANIZATION_COOKIE_MAX_AGE = 10 * 60;

export function organizationChoiceValue(sessionId: string, organizationId: string): string {
  return `${sessionId}:${organizationId}`;
}

/** Whether the request carries a choice made in this session for its current active organization. */
export function hasChosenOrganization(cookieHeader: string | null, sessionId: string, activeOrganizationId: unknown): boolean {
  if (!cookieHeader || typeof activeOrganizationId !== "string" || !activeOrganizationId) return false;
  const expected = organizationChoiceValue(sessionId, activeOrganizationId);
  return cookieHeader.split(";").some((part) => {
    const [name, ...rest] = part.trim().split("=");
    return name === OAUTH_ORGANIZATION_COOKIE && decodeURIComponent(rest.join("=")) === expected;
  });
}
