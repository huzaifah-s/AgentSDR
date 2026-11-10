/**
 * API keys (Settings → API keys): how another application calls AgentSDR's
 * public API (/api/v1/*) as an organization. Matches src/lib/publicApi/schema.ts
 * and src/lib/tenancy/registry.ts.
 *
 * Run with:  bun run scripts/create-api-keys.ts
 *
 * - api_keys: one row per key. Only the key's SHA-256 hash is stored; the key
 *   itself is shown once, when it is created. `key_hash` is unique across
 *   organizations because a request finds its organization through it, the
 *   way a webhook finds it through a provider id.
 * - Revoking sets `revoked_at`; the row stays so "last used" remains visible.
 *
 * Additive and re-runnable: every statement is guarded.
 */
import { Client } from "pg";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS api_keys (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     organization_id uuid NOT NULL REFERENCES organizations(id),
     name text NOT NULL,
     key_prefix text NOT NULL,
     key_hash text NOT NULL,
     created_by uuid REFERENCES users(id) ON DELETE SET NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_used_at timestamptz,
     revoked_at timestamptz
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_uq ON api_keys (key_hash)`,
  `CREATE INDEX IF NOT EXISTS api_keys_organization_idx ON api_keys (organization_id)`,
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '2min'");
    for (const statement of STATEMENTS) await client.query(statement);
    const { rows } = await client.query<{ present: boolean }>(
      `SELECT to_regclass('public.api_keys') IS NOT NULL AS present`,
    );
    console.log(`api_keys ${rows[0]?.present ? "present" : "MISSING"}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
