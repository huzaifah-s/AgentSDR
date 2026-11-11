/**
 * LinkedIn posts written in AgentSDR (docs/linkedin-content/plan.md). A
 * snake_case table this app owns, unlike the ex-Prisma LinkedIn tables in
 * ../schema.ts. Created by scripts/create-linkedin-post-tables.ts.
 *
 * `linkedinAccountId` is `text` because "LinkedInAccount".id is. Its foreign
 * key is declared here by name, the way the tables pointing at `people` do:
 * drizzle-kit does not manage "LinkedInAccount" itself (it is not in
 * OWNED_TABLES), but it does manage this table's constraints, and a key
 * missing here is one `drizzle-kit push` would drop.
 */
import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import type {
  LinkedinPostAttachment,
  LinkedinPostGeneration,
  LinkedinPostSource,
  LinkedinPostStatus,
} from "./contract";

export const linkedinPosts = pgTable(
  "linkedin_posts",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    linkedinAccountId: text("linkedin_account_id").notNull(),
    status: text("status").notNull().default("draft").$type<LinkedinPostStatus>(),
    body: text("body").notNull().default(""),
    attachments: jsonb("attachments").notNull().default([]).$type<LinkedinPostAttachment[]>(),
    source: jsonb("source").$type<LinkedinPostSource>(),
    generation: jsonb("generation").$type<LinkedinPostGeneration>(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    providerPostId: text("provider_post_id"),
    postUrl: text("post_url"),
    error: text("error"),
    createdBy: text("created_by"),
    publishedBy: text("published_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.linkedinAccountId],
      foreignColumns: [linkedInAccounts.id],
      name: "linkedin_posts_account_fk",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    index("linkedin_posts_org_status_scheduled_idx").on(table.organizationId, table.status, table.scheduledAt),
    index("linkedin_posts_org_account_published_idx").on(table.organizationId, table.linkedinAccountId, table.publishedAt),
    index("linkedin_posts_account_idx").on(table.linkedinAccountId),
    uniqueIndex("linkedin_posts_provider_post_id_uq")
      .on(table.providerPostId)
      .where(sql`${table.providerPostId} IS NOT NULL`),
    check(
      "linkedin_posts_status_chk",
      sql`${table.status} IN ('draft', 'scheduled', 'publishing', 'published', 'failed')`,
    ),
    check("linkedin_posts_body_length_chk", sql`char_length(${table.body}) <= 3000`),
    check("linkedin_posts_attachments_chk", sql`jsonb_typeof(${table.attachments}) = 'array'`),
  ],
);

export type LinkedinPostRow = typeof linkedinPosts.$inferSelect;
