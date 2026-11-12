import "server-only";

import { eq } from "drizzle-orm";
import { isMemberOf, MCP_RESOURCE } from "@/lib/auth/oauthProvider";
import { oauthAccessTokens, oauthClients } from "@/lib/auth/schema";
import { db } from "@/lib/db";
import type { ApiCaller } from "./access";
import { accessTokenDecision, hashOpaqueToken } from "./oauthToken";

/**
 * The caller behind an OAuth access token at /api/v1/mcp, or null. Runs
 * outside any organization scope, like an API key: the token names its
 * organization (`reference_id`, chosen at consent), and the person must still
 * be a member of it, checked on every request, so leaving or being removed
 * from an organization cuts off their connected apps at once.
 */
export async function callerForOAuthToken(token: string): Promise<ApiCaller | null> {
  const [row] = await db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.token, hashOpaqueToken(token))).limit(1);
  const [client] = row
    ? await db.select({ disabled: oauthClients.disabled }).from(oauthClients).where(eq(oauthClients.clientId, row.clientId)).limit(1)
    : [];

  const decision = accessTokenDecision({
    token: row
      ? {
          clientId: row.clientId,
          userId: row.userId,
          referenceId: row.referenceId,
          resources: row.resources,
          scopes: row.scopes,
          expiresAt: row.expiresAt,
          revoked: row.revoked,
          confirmation: row.confirmation,
        }
      : null,
    client: client ?? null,
    resource: MCP_RESOURCE,
    now: new Date(),
  });
  if (!decision.ok) return null;
  if (!(await isMemberOf(decision.userId, decision.organizationId))) return null;
  return {
    organizationId: decision.organizationId,
    scopes: decision.scopes,
    credential: { kind: "oauth", userId: decision.userId, clientId: decision.clientId },
  };
}
