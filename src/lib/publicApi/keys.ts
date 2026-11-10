import "server-only";

import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { apiKeys } from "./schema";
import { apiKeyFromAuthorization, createApiKeySecret, hashApiKey } from "./token";

/** What Settings shows for a key; never the key or its hash. */
export type ApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

const MAX_NAME_LENGTH = 100;

/** `last_used_at` is written at most this often per key, so a busy caller is not a write per request. */
const LAST_USED_RESOLUTION_MS = 60_000;

function summary(row: typeof apiKeys.$inferSelect): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** The organization's keys, newest first. Runs inside an organization scope. */
export async function listApiKeys(): Promise<ApiKeySummary[]> {
  const rows = await db.select().from(apiKeys).where(inOrg(apiKeys)).orderBy(desc(apiKeys.createdAt));
  return rows.map(summary);
}

/** Creates a key; the returned `key` is the only time it exists in clear. */
export async function createApiKey(name: string, createdBy: string): Promise<{ key: string; apiKey: ApiKeySummary }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the key a name");
  if (trimmed.length > MAX_NAME_LENGTH) throw new Error(`Keep the name under ${MAX_NAME_LENGTH} characters`);
  const { key, hash, prefix } = createApiKeySecret();
  const [row] = await db
    .insert(apiKeys)
    .values({ organizationId: currentOrganizationId(), name: trimmed, keyPrefix: prefix, keyHash: hash, createdBy })
    .returning();
  return { key, apiKey: summary(row) };
}

/** Revokes a key of this organization. False when there is no such key. Revoking twice is harmless. */
export async function revokeApiKey(id: string): Promise<boolean> {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(inOrg(apiKeys), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  if (row) return true;
  const [existing] = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(inOrg(apiKeys), eq(apiKeys.id, id))).limit(1);
  return !!existing;
}

/**
 * The organization a request's API key belongs to, or null when the key is
 * missing, unknown or revoked. Runs outside any organization scope: like a
 * webhook, the request finds its organization through the data (the key's
 * hash, unique across organizations).
 */
export async function organizationForApiKey(authorization: string | null): Promise<{ organizationId: string; keyId: string } | null> {
  const key = apiKeyFromAuthorization(authorization);
  if (!key) return null;
  const [row] = await db
    .select({ id: apiKeys.id, organizationId: apiKeys.organizationId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;

  const now = new Date();
  await db
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(and(
      eq(apiKeys.id, row.id),
      or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS))),
    ));
  return { organizationId: row.organizationId, keyId: row.id };
}
