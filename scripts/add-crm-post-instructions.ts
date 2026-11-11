/**
 * The organization's LinkedIn content brief, edited on Settings →
 * Instructions → LinkedIn posts beside the calling instructions:
 * crm_settings.post_instructions (titled blocks; null = the defaults in
 * src/lib/linkedin/posts/postInstructions.ts). Matches src/lib/crm/schema.ts;
 * see docs/linkedin-content/plan.md, Phase 5.
 *
 * Run with:  bun run scripts/add-crm-post-instructions.ts
 *
 * Additive and re-runnable.
 */
import { Client } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query(`ALTER TABLE crm_settings ADD COLUMN IF NOT EXISTS post_instructions jsonb`);
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_settings_post_instructions_shape_chk') THEN
        ALTER TABLE crm_settings ADD CONSTRAINT crm_settings_post_instructions_shape_chk
          CHECK (post_instructions IS NULL OR (jsonb_typeof(post_instructions) = 'array' AND length(post_instructions::text) <= 60000));
      END IF;
    END $$`);
    console.log("crm_settings.post_instructions ready");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
