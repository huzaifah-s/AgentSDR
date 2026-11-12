/**
 * Read-only API keys: `api_keys.access` is `read` or `read_write`
 * (src/lib/publicApi/access.ts, src/lib/publicApi/schema.ts).
 *
 * Run with:  bun run scripts/add-api-key-access.ts
 *
 * Every key created before this could already add and stop leads, so the
 * default, `read_write`, keeps them exactly as they were. A read-only key
 * lists campaigns, reads their numbers and leads' status, and reads the CRM's
 * Action required queue; the MCP server does not offer it the write tools.
 *
 * Additive and re-runnable: every statement is guarded.
 */
import { Client } from "pg";

const STATEMENTS = [
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS access text NOT NULL DEFAULT 'read_write'`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_access_check') THEN
       ALTER TABLE api_keys ADD CONSTRAINT api_keys_access_check CHECK (access IN ('read', 'read_write'));
     END IF;
   END $$`,
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
    const { rows } = await client.query<{ access: string; keys: number }>(
      `SELECT access, count(*)::int AS keys FROM api_keys GROUP BY access ORDER BY access`,
    );
    console.log(`api_keys.access present: ${rows.map((r) => `${r.access}=${r.keys}`).join(", ") || "no keys yet"}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
