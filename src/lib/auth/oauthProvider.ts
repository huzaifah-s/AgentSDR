import "server-only";

import { oauthProvider } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { API_SCOPES } from "@/lib/publicApi/access";
import { hasChosenOrganization } from "./oauthOrganizationChoice";
import { members } from "./schema";

/**
 * BraintreeSDR as an OAuth authorization server, for MCP clients that can
 * connect only through OAuth, such as claude.ai custom connectors
 * (docs/mcp/plan.md, phase 2; docs/mcp.mdx).
 *
 * - The only resource is the MCP endpoint, and the only scopes are the public
 *   API's (src/lib/publicApi/access.ts) plus offline_access for refresh
 *   tokens. It is not an OpenID provider (no `openid` scope).
 * - Access tokens are opaque (no JWT plugin, so no signing keys to manage),
 *   stored hashed, checked by src/lib/publicApi/oauth.ts.
 * - A token acts as a person inside one organization: the plugin's postLogin
 *   step sends a member of several organizations to /oauth/organization, and
 *   the organization they choose becomes the consent's and every token's
 *   `referenceId`, after a membership check here and again on every request.
 * - Clients register themselves (RFC 7591, open), which is how MCP clients
 *   connect. A registered client gets nothing on its own: every token needs a
 *   signed-in person's consent, PKCE, and a redirect the client registered.
 *   Managing clients from a session (create, edit, list, delete) is refused
 *   for everyone, so nobody can give a client fields such as skip_consent.
 */

const baseURL = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";

/** The MCP endpoint, which is the one OAuth resource (RFC 8707 audience). */
export const MCP_RESOURCE = `${baseURL.replace(/\/+$/, "")}/api/v1/mcp`;

export const OAUTH_SCOPES = [...API_SCOPES, "offline_access"] as const;

/** The authorization server's issuer: Better Auth is mounted at /api/auth. */
export const OAUTH_ISSUER = `${baseURL.replace(/\/+$/, "")}/api/auth`;

/**
 * RFC 9728 metadata for the MCP endpoint, at the path-suffixed well-known
 * URL MCP clients try first. A 401 from /api/v1/mcp points here.
 */
export const MCP_RESOURCE_METADATA_URL = `${baseURL.replace(/\/+$/, "")}/.well-known/oauth-protected-resource/api/v1/mcp`;

export function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "BraintreeSDR",
  };
}

/** Organizations a user belongs to, oldest membership first. */
async function membershipsOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ organizationId: members.organizationId })
    .from(members)
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt));
  return rows.map((row) => row.organizationId);
}

export async function isMemberOf(userId: string, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, organizationId)))
    .limit(1);
  return Boolean(row);
}

/**
 * The organization a consent and its tokens belong to: the session's active
 * one (what /oauth/organization sets) when the person is a member of it,
 * else their only organization. Fails closed otherwise.
 */
async function consentOrganization(user: { id: string }, session: Record<string, unknown>): Promise<string> {
  const active = typeof session.activeOrganizationId === "string" ? session.activeOrganizationId : null;
  if (active && (await isMemberOf(user.id, active))) return active;
  const memberships = await membershipsOf(user.id);
  if (memberships.length === 1) return memberships[0];
  throw new APIError("FORBIDDEN", {
    error: "access_denied",
    error_description: memberships.length === 0 ? "You are not a member of any organization" : "Choose an organization first",
  });
}

export function buildOAuthProvider() {
  return oauthProvider({
    loginPage: "/sign-in",
    consentPage: "/oauth/consent",
    scopes: [...OAUTH_SCOPES],
    disableJwtPlugin: true,
    grantTypes: ["authorization_code", "refresh_token"],
    resources: [{ identifier: MCP_RESOURCE, name: "BraintreeSDR MCP server", allowedScopes: [...OAUTH_SCOPES] }],
    clientRegistrationDefaultResources: [MCP_RESOURCE],
    clientRegistrationAllowedResources: [MCP_RESOURCE],
    clientRegistrationDefaultScopes: [...OAUTH_SCOPES],
    clientRegistrationAllowedScopes: [...OAUTH_SCOPES],
    clientRegistrationRequirePKCE: true,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientPrivileges: () => false,
    postLogin: {
      page: "/oauth/organization",
      // A member of several organizations chooses one, once per authorization
      // (src/lib/auth/oauthOrganizationChoice.ts); one organization needs no choice.
      shouldRedirect: async ({ headers, user, session }) =>
        (await membershipsOf(user.id)).length > 1 &&
        !hasChosenOrganization(headers.get("cookie"), session.id, (session as Record<string, unknown>).activeOrganizationId),
      consentReferenceId: async ({ user, session }) => consentOrganization(user, session),
    },
    silenceWarnings: { oauthAuthServerConfig: true },
  });
}
