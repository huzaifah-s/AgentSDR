import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { API_SCOPES, type ApiScope } from "@/lib/publicApi/access";
import { oauthAccessTokens, oauthClients, oauthConsents, oauthRefreshTokens, organizations } from "./schema";

/**
 * Settings, Connected apps: the apps a person allowed through OAuth (MCP
 * clients such as claude.ai connectors), and disconnecting one.
 *
 * Disconnecting is ours, not the plugin's /oauth2/delete-consent: that
 * deletes the consent and leaves the app's access and refresh tokens working
 * until they expire. Here the consent goes and every token the app holds for
 * that person and organization is revoked in the same transaction, which
 * /api/v1/mcp sees on the next request (src/lib/publicApi/oauth.ts).
 */

export type ConnectedApp = {
  id: string;
  clientName: string;
  clientUri: string | null;
  organizationId: string | null;
  organizationName: string | null;
  scopes: ApiScope[];
  stayConnected: boolean;
  connectedAt: string | null;
  updatedAt: string | null;
};

export async function listConnectedApps(userId: string): Promise<ConnectedApp[]> {
  const rows = await db
    .select({ consent: oauthConsents, clientName: oauthClients.name, clientUri: oauthClients.uri, organizationName: organizations.name })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    // reference_id is text (the plugin writes strings); organizations.id is uuid.
    .leftJoin(organizations, sql`${organizations.id}::text = ${oauthConsents.referenceId}`)
    .where(eq(oauthConsents.userId, userId))
    .orderBy(desc(oauthConsents.updatedAt));
  return rows.map(({ consent, clientName, clientUri, organizationName }) => ({
    id: consent.id,
    clientName: clientName?.trim() || "An application",
    clientUri,
    organizationId: consent.referenceId,
    organizationName: organizationName ?? null,
    scopes: API_SCOPES.filter((scope) => consent.scopes.includes(scope)),
    stayConnected: consent.scopes.includes("offline_access"),
    connectedAt: consent.createdAt?.toISOString() ?? null,
    updatedAt: consent.updatedAt?.toISOString() ?? null,
  }));
}

/** Disconnects one of the person's apps. False when they have no such consent. */
export async function disconnectApp(userId: string, consentId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [consent] = await tx
      .delete(oauthConsents)
      .where(and(eq(oauthConsents.id, consentId), eq(oauthConsents.userId, userId)))
      .returning({ clientId: oauthConsents.clientId, referenceId: oauthConsents.referenceId });
    if (!consent) return false;
    const now = new Date();
    const sameGrant = <T extends typeof oauthAccessTokens | typeof oauthRefreshTokens>(table: T) =>
      and(
        eq(table.clientId, consent.clientId),
        eq(table.userId, userId),
        consent.referenceId ? eq(table.referenceId, consent.referenceId) : isNull(table.referenceId),
        isNull(table.revoked),
      );
    await tx.update(oauthRefreshTokens).set({ revoked: now }).where(sameGrant(oauthRefreshTokens));
    await tx.update(oauthAccessTokens).set({ revoked: now }).where(sameGrant(oauthAccessTokens));
    return true;
  });
}
