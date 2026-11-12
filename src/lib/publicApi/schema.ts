import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "@/lib/auth/schema";
import type { ApiKeyAccess } from "./access";

/**
 * Keys another application uses to call the public API (/api/v1/*) as one
 * organization (scripts/create-api-keys.ts). Only the SHA-256 hash of a key
 * is stored; `keyPrefix` is its first characters, shown so people can tell
 * keys apart. `keyHash` is unique across organizations: a request finds its
 * organization through it. `access` is `read` or `read_write`
 * (src/lib/publicApi/access.ts; scripts/add-api-key-access.ts).
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    access: text("access").notNull().default("read_write").$type<ApiKeyAccess>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_uq").on(t.keyHash),
    index("api_keys_organization_idx").on(t.organizationId),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
