/**
 * Creates linkedin_author_voices — each person's writing voice for LinkedIn
 * posts, one row per (organization, LinkedIn account). Matches
 * src/lib/linkedin/posts/schema.ts; see docs/linkedin-content/plan.md,
 * Phase 5, "Each person's writing voice".
 *
 * Run with:  bun run scripts/create-linkedin-author-voices.ts
 *
 * A new table only; nothing existing changes. Re-runnable: the table and its
 * index are guarded. Keys are named as the Drizzle schema names them, so
 * `drizzle-kit push` finds nothing to change (as for linkedin_posts).
 * ON DELETE CASCADE with the account, like linkedin_posts.
 */
import { Client } from "pg";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS linkedin_author_voices (
     organization_id uuid NOT NULL,
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     linkedin_account_id text NOT NULL,
     instructions jsonb,
     example_posts jsonb NOT NULL DEFAULT '[]'::jsonb,
     updated_by text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT linkedin_author_voices_organization_id_organizations_id_fk FOREIGN KEY (organization_id)
       REFERENCES organizations(id),
     CONSTRAINT linkedin_author_voices_account_fk FOREIGN KEY (linkedin_account_id)
       REFERENCES "LinkedInAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE,
     CONSTRAINT linkedin_author_voices_org_account_uq UNIQUE (organization_id, linkedin_account_id),
     CONSTRAINT linkedin_author_voices_instructions_chk
       CHECK (instructions IS NULL OR (jsonb_typeof(instructions) = 'array' AND length(instructions::text) <= 60000)),
     CONSTRAINT linkedin_author_voices_examples_chk
       CHECK (jsonb_typeof(example_posts) = 'array' AND jsonb_array_length(example_posts) <= 5 AND length(example_posts::text) <= 40000)
   )`,
  `CREATE INDEX IF NOT EXISTS linkedin_author_voices_account_idx ON linkedin_author_voices (linkedin_account_id)`,
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
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM linkedin_author_voices`);
    console.log(`linkedin_author_voices ready (${rows[0]?.n ?? 0} rows)`);
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
