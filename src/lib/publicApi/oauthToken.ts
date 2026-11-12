import { createHash } from "node:crypto";
import { API_SCOPES, type ApiScope } from "./access";

/**
 * The rules for accepting an OAuth access token at /api/v1/mcp, kept pure so
 * they are tested without a database (src/lib/publicApi/oauth.ts reads the
 * rows). They follow what @better-auth/oauth-provider's own introspection
 * checks for an opaque token (validateOpaqueAccessToken in 1.7.7), plus ours:
 * the token must name an organization, and be for this resource.
 *
 * One of the plugin's checks is left out on purpose: that the browser session
 * the token came from is still live. Its refresh grant copies that session id
 * onto every new access token without checking it, and signing out nulls it,
 * so the check would cut a connected app off when the session happened to
 * expire but not when the person signed out. A connected app is the person's
 * standing permission instead: it lasts until they disconnect it, leave the
 * organization, or its refresh token runs out.
 */

/** How the plugin stores an opaque token: SHA-256, base64url without padding (storeTokens: "hashed"). */
export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AccessTokenRow = {
  clientId: string;
  userId: string | null;
  referenceId: string | null;
  resources: string[] | null;
  scopes: string[];
  expiresAt: Date | null;
  revoked: Date | null;
  confirmation: unknown;
};

export type TokenDecision =
  | { ok: true; userId: string; organizationId: string; clientId: string; scopes: ReadonlySet<ApiScope> }
  | { ok: false; reason: string };

export function accessTokenDecision(input: {
  token: AccessTokenRow | null;
  /** The token's client; null when it no longer exists. */
  client: { disabled: boolean | null } | null;
  resource: string;
  now: Date;
}): TokenDecision {
  const { token, client, resource, now } = input;
  if (!token) return { ok: false, reason: "unknown token" };
  if (!token.expiresAt || token.expiresAt <= now) return { ok: false, reason: "expired" };
  if (token.revoked) return { ok: false, reason: "revoked" };
  // A sender-constrained (DPoP) token needs a proof this server does not check.
  if (token.confirmation) return { ok: false, reason: "sender-constrained token" };
  if (!client || client.disabled) return { ok: false, reason: "client disabled or gone" };
  // A token issued for some other resource is not for us. One with no
  // resource at all can only have come from this server's authorization
  // endpoint, whose only resource is this one.
  if (token.resources?.length && !token.resources.includes(resource)) return { ok: false, reason: "issued for another resource" };
  if (!token.userId) return { ok: false, reason: "no user" };
  // Our consentReferenceId only ever writes an organization id; anything else
  // would also fail the uuid membership lookup.
  if (!token.referenceId || !UUID.test(token.referenceId)) return { ok: false, reason: "no organization" };
  const scopes = new Set(API_SCOPES.filter((scope) => token.scopes.includes(scope)));
  if (scopes.size === 0) return { ok: false, reason: "no usable scope" };
  return { ok: true, userId: token.userId, organizationId: token.referenceId, clientId: token.clientId, scopes };
}
