/**
 * Creates linkedin_posts — LinkedIn posts written in AgentSDR and published
 * from a connected LinkedIn account. Matches src/lib/linkedin/posts/schema.ts;
 * see docs/linkedin-content/plan.md.
 *
 * Run with:  bun run scripts/create-linkedin-post-tables.ts
 *
 * A new table only; nothing existing changes. Re-runnable: the table and
 * every index are guarded.
 *
 * linkedin_account_id is `text` because "LinkedInAccount".id is (ex-Prisma
 * cuids). ON DELETE CASCADE, like "CampaignAccount": nothing in the app
 * deletes an account, and one deleted by hand takes its posts with it.
 *
 * Both foreign keys are named as the Drizzle schema names them, so
 * `drizzle-kit push` finds nothing to change on this table (an unnamed
 * REFERENCES gets Postgres's `_fkey` name, which drizzle-kit would drop and
 * re-add under its own).
 *
 * provider_post_id is unique across organizations (a provider identity, like
 * message ids), not per organization.
 */
import { Client } from "pg";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS linkedin_posts (
     organization_id uuid NOT NULL,
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     linkedin_account_id text NOT NULL,
     status text NOT NULL DEFAULT 'draft',
     body text NOT NULL DEFAULT '',
     attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
     source jsonb,
     generation jsonb,
     scheduled_at timestamptz,
     published_at timestamptz,
     provider_post_id text,
     post_url text,
     error text,
     created_by text,
     published_by text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT linkedin_posts_organization_id_organizations_id_fk FOREIGN KEY (organization_id)
       REFERENCES organizations(id),
     CONSTRAINT linkedin_posts_account_fk FOREIGN KEY (linkedin_account_id)
       REFERENCES "LinkedInAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE,
     CONSTRAINT linkedin_posts_status_chk
       CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'failed')),
     CONSTRAINT linkedin_posts_body_length_chk CHECK (char_length(body) <= 3000),
     CONSTRAINT linkedin_posts_attachments_chk CHECK (jsonb_typeof(attachments) = 'array')
   )`,
  `CREATE INDEX IF NOT EXISTS linkedin_posts_org_status_scheduled_idx
     ON linkedin_posts (organization_id, status, scheduled_at)`,
  `CREATE INDEX IF NOT EXISTS linkedin_posts_org_account_published_idx
     ON linkedin_posts (organization_id, linkedin_account_id, published_at)`,
  `CREATE INDEX IF NOT EXISTS linkedin_posts_account_idx ON linkedin_posts (linkedin_account_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS linkedin_posts_provider_post_id_uq
     ON linkedin_posts (provider_post_id) WHERE provider_post_id IS NOT NULL`,
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '2min'");
    await client.query("BEGIN");
    for (const statement of STATEMENTS) await client.query(statement);
    await client.query("COMMIT");
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM linkedin_posts`);
    console.log(`linkedin_posts ready (${rows[0]?.n ?? 0} rows)`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
