import "server-only";

import { asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { auth } from "./server";
import { members, oauthClients, organizations } from "./schema";

/**
 * What the /oauth pages show (src/app/oauth/*): the person's organizations
 * to choose from, and the client and organization a consent is for. The
 * decisions themselves are the plugin's (/api/auth/oauth2/continue and
 * /oauth2/consent) and src/lib/auth/oauthProvider.ts's.
 */

export type OAuthOrganizationChoice = { id: string; name: string };

export async function oauthSession() {
  return auth.api.getSession({ headers: await headers() });
}

export async function organizationChoices(userId: string): Promise<OAuthOrganizationChoice[]> {
  return db
    .select({ id: organizations.id, name: organizations.name })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt));
}

export type OAuthClientSummary = { name: string; uri: string | null };

/** A registered client's own name, as it registered it; unknown when the id is not ours. */
export async function clientSummary(clientId: string): Promise<OAuthClientSummary | null> {
  const [row] = await db
    .select({ name: oauthClients.name, uri: oauthClients.uri, disabled: oauthClients.disabled })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  if (!row || row.disabled) return null;
  return { name: row.name?.trim() || "An application", uri: row.uri };
}

/** The organization a consent from this session would be for: the same rule as consentOrganization. */
export function consentOrganizationFor(
  choices: OAuthOrganizationChoice[],
  activeOrganizationId: string | null | undefined,
): OAuthOrganizationChoice | null {
  const active = choices.find((choice) => choice.id === activeOrganizationId);
  if (active) return active;
  return choices.length === 1 ? choices[0] : null;
}
