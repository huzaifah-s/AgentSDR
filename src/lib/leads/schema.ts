import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  doublePrecision,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { gridTables } from "@/lib/grid/schema";
import type { LeadColumnType, LeadEntity, LeadPgType } from "./types";
import { organizations } from "@/lib/auth/schema";

/**
 * The lead database — one People table and one Companies table, shared by
 * every campaign on both channels.
 *
 * Created by scripts/create-lead-tables.ts.
 *
 * ---------------------------------------------------------------------------
 * THESE TABLES ARE NOT IN OWNED_TABLES, AND MUST NOT BE ADDED TO IT
 * ---------------------------------------------------------------------------
 * They are hand-maintained through scripts/, like the LinkedIn tables. Custom
 * fields no longer add physical columns: their values are keys in the `custom`
 * jsonb and their definitions are per-organization rows in `entity_columns`
 * (src/lib/leads/columns.ts). Every table here is scoped by organization_id.
 */

/**
 * A company. Identity is the normalized domain — the one field an enriched
 * list reliably carries, and the only one that survives a company rename.
 */
export const companies = pgTable(
  "companies",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    /** normalizeDomainForTargeting(); the identity key. */
    domain: text("domain").notNull(),
    name: text("name"),
    linkedinUrl: text("linkedin_url"),
    /**
     * Import columns the user chose not to map. Kept rather than dropped, so a
     * mis-mapped import is recoverable without re-uploading the file — and so
     * a column can be "promoted" later by mapping it on the next import.
     */
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    /** grid:<tableId> | import:<runId> | manual */
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("companies_org_domain_uq").on(t.organizationId, t.domain),
    index("companies_organization_idx").on(t.organizationId), index("companies_name_idx").on(t.name)],
);

/**
 * A person.
 *
 * `companyId` is NULLABLE on purpose: a person imported from a LinkedIn list
 * usually has no resolvable domain, and a person with no company is still a
 * person worth storing. Requiring it would mean inventing placeholder
 * companies, which poisons every company-level count.
 */
export const people = pgTable(
  "people",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email"),
    /**
     * The bare slug ("janedoe42"), never a full URL — the format
     * "Lead".linkedinUrl already uses on 100% of its 18k rows. Normalized by
     * normalizeLinkedinSlug() in ./identity.
     */
    linkedinUrl: text("linkedin_url"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    fullName: text("full_name"),
    title: text("title"),
    /**
     * The LinkedIn profile picture, as a signed media.licdn.com URL. Stored on
     * the person rather than the campaign Lead so the CRM and the people
     * table can show it without crossing into the LinkedIn schema.
     */
    profilePictureUrl: text("profile_picture_url"),
    /**
     * E.164 ("+919876543210"), normalized by normalizePhone() in
     * @/lib/calls/phone. What the Call button dials on WhatsApp.
     * scripts/add-people-phone.ts added it.
     */
    phone: text("phone"),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("people_org_email_uq")
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`${t.email} IS NOT NULL`),
    uniqueIndex("people_org_linkedin_url_uq")
      .on(t.organizationId, t.linkedinUrl)
      .where(sql`${t.linkedinUrl} IS NOT NULL`),
    index("people_organization_idx").on(t.organizationId),
    index("people_company_idx").on(t.companyId),
    index("people_created_idx").on(t.createdAt),
  ],
  // The two partial unique indexes (people_email_uq, people_linkedin_url_uq)
  // are created in scripts/create-lead-tables.ts. Drizzle cannot express a
  // partial index here, and they must be partial: a person identified by slug
  // has a NULL email, and NULLs would collide under a plain UNIQUE.
);

/**
 * The custom-field registry — one per organization (core rows included,
 * created lazily). NOT storage: values live in people.custom /
 * companies.custom under `key`. It is the allowlist a key must match before
 * it is filtered or sorted on. See ./columns.ts.
 */
export const entityColumns = pgTable(
  "entity_columns",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    entity: text("entity").notNull().$type<LeadEntity>(),
    /**
     * The PHYSICAL Postgres column name. Generated from the label, never
     * user-supplied, and never changed after creation — which is what makes a
     * rename free. User columns are prefixed `x_`; see ./types.ts.
     */
    key: text("key").notNull(),
    /** Display label. Renaming touches this row and runs zero DDL. */
    name: text("name").notNull(),
    /** UI type, shared vocabulary with the grid's StaticColumnType. */
    type: text("type").notNull().$type<LeadColumnType>(),
    /** Physical type used in the ALTER TABLE. Restricted set — see ./types.ts. */
    pgType: text("pg_type").notNull().$type<LeadPgType>(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Core columns ship with the table; they cannot be dropped or retyped. */
    isCore: boolean("is_core").notNull().default(false),
    /** Fractional index, so reordering touches one row. */
    position: doublePrecision("position").notNull(),
    /**
     * Soft delete. The column vanishes from the UI, the mapping catalog and
     * queries but keeps its data; a physical DROP COLUMN is a separate,
     * explicitly confirmed act, because DROP is not recoverable.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("entity_columns_organization_idx").on(t.organizationId),
    uniqueIndex("entity_columns_org_entity_key_uq").on(t.organizationId, t.entity, t.key),
    index("entity_columns_entity_pos_idx").on(t.entity, t.position),
  ],
);

/**
 * One import. Storing the exact mapping means re-importing the same list is a
 * single click, and a bad import is diagnosable after the fact rather than
 * being reconstructed from the resulting rows.
 */
export const importRuns = pgTable(
  "import_runs",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    /** grid | file | api (the public API, src/lib/publicApi/) */
    source: text("source").notNull().$type<"grid" | "file" | "api">(),
    gridTableId: uuid("grid_table_id").references(() => gridTables.id, { onDelete: "set null" }),
    filename: text("filename"),
    /** database | campaign */
    destination: text("destination").notNull().$type<"database" | "campaign">(),
    /** UUID for email campaigns, cuid/text for LinkedIn campaigns. */
    destinationCampaignId: text("destination_campaign_id"),
    mapping: jsonb("mapping").$type<unknown>().notNull(),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("import_runs_organization_idx").on(t.organizationId), index("import_runs_created_idx").on(t.createdAt)],
);
