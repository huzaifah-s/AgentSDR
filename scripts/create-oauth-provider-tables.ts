/**
 * OAuth provider tables (@better-auth/oauth-provider 1.7.7), so MCP clients
 * that can only connect through OAuth, such as claude.ai connectors, can act
 * as a signed-in person inside one organization. Matches the OAuth section of
 * src/lib/auth/schema.ts and AUTH_TABLES in src/lib/tenancy/registry.ts.
 *
 * Run with:  bun run scripts/create-oauth-provider-tables.ts
 *
 * Like Better Auth's own tables these have no organization_id: a client is
 * registered for the whole instance, and a token belongs to a person, with
 * the organization they chose at consent in `reference_id`, re-checked
 * against their membership on every MCP request (src/lib/publicApi/oauth.ts).
 * Tokens, codes and client secrets are stored as SHA-256 hashes.
 *
 * Additive and re-runnable: every statement is guarded.
 */
import { Client } from "pg";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS oauth_clients (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     client_id text NOT NULL UNIQUE,
     client_secret text,
     client_discovery_id text,
     disabled boolean DEFAULT false,
     skip_consent boolean,
     enable_end_session boolean,
     subject_type text,
     scopes text[],
     client_credentials_scopes text[] DEFAULT '{}',
     user_id uuid REFERENCES users(id) ON DELETE CASCADE,
     created_at timestamptz DEFAULT now(),
     updated_at timestamptz DEFAULT now(),
     name text,
     uri text,
     icon text,
     contacts text[],
     tos text,
     policy text,
     software_id text,
     software_version text,
     software_statement text,
     redirect_uris text[] NOT NULL,
     post_logout_redirect_uris text[],
     backchannel_logout_uri text,
     backchannel_logout_session_required boolean,
     token_endpoint_auth_method text,
     application_type text,
     jwks text,
     jwks_uri text,
     grant_types text[],
     response_types text[],
     require_pkce boolean,
     dpop_bound_access_tokens boolean DEFAULT false,
     reference_id text,
     metadata jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS oauth_clients_user_id_idx ON oauth_clients (user_id)`,

  `CREATE TABLE IF NOT EXISTS oauth_resources (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     identifier text NOT NULL UNIQUE,
     name text NOT NULL,
     access_token_ttl integer,
     refresh_token_ttl integer,
     signing_algorithm text,
     signing_key_id text,
     allowed_scopes text[],
     custom_claims jsonb,
     dpop_bound_access_tokens_required boolean DEFAULT false,
     disabled boolean DEFAULT false,
     created_at timestamptz DEFAULT now(),
     updated_at timestamptz DEFAULT now(),
     policy_version integer DEFAULT 1,
     metadata jsonb
   )`,

  `CREATE TABLE IF NOT EXISTS oauth_client_resources (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
     resource_id text NOT NULL REFERENCES oauth_resources(identifier) ON DELETE CASCADE,
     metadata jsonb,
     created_at timestamptz DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS oauth_client_resources_client_resource_uq ON oauth_client_resources (client_id, resource_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_client_resources_resource_id_idx ON oauth_client_resources (resource_id)`,

  `CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     token text NOT NULL UNIQUE,
     client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
     session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     reference_id text,
     authorization_code_id text,
     resources text[],
     requested_user_info_claims text[],
     expires_at timestamptz,
     created_at timestamptz DEFAULT now(),
     revoked timestamptz,
     rotated_at timestamptz,
     rotation_replay_response text,
     rotation_replay_expires_at timestamptz,
     auth_time timestamptz,
     confirmation jsonb,
     scopes text[] NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_client_id_idx ON oauth_refresh_tokens (client_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_session_id_idx ON oauth_refresh_tokens (session_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_user_id_idx ON oauth_refresh_tokens (user_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_authorization_code_id_idx ON oauth_refresh_tokens (authorization_code_id)`,

  `CREATE TABLE IF NOT EXISTS oauth_access_tokens (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     token text UNIQUE,
     client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
     session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
     user_id uuid REFERENCES users(id) ON DELETE CASCADE,
     reference_id text,
     authorization_code_id text,
     resources text[],
     requested_user_info_claims text[],
     refresh_id uuid REFERENCES oauth_refresh_tokens(id) ON DELETE CASCADE,
     expires_at timestamptz,
     created_at timestamptz DEFAULT now(),
     revoked timestamptz,
     confirmation jsonb,
     scopes text[] NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS oauth_access_tokens_client_id_idx ON oauth_access_tokens (client_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_access_tokens_session_id_idx ON oauth_access_tokens (session_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_access_tokens_user_id_idx ON oauth_access_tokens (user_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_access_tokens_authorization_code_id_idx ON oauth_access_tokens (authorization_code_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_access_tokens_refresh_id_idx ON oauth_access_tokens (refresh_id)`,

  `CREATE TABLE IF NOT EXISTS oauth_consents (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
     user_id uuid REFERENCES users(id) ON DELETE CASCADE,
     reference_id text,
     resources text[],
     requested_user_info_claims text[],
     scopes text[] NOT NULL,
     created_at timestamptz DEFAULT now(),
     updated_at timestamptz DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS oauth_consents_client_id_idx ON oauth_consents (client_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_consents_user_id_idx ON oauth_consents (user_id)`,

  `CREATE TABLE IF NOT EXISTS oauth_client_assertions (
     id text PRIMARY KEY,
     expires_at timestamptz NOT NULL
   )`,
];

const TABLES = [
  "oauth_clients",
  "oauth_resources",
  "oauth_client_resources",
  "oauth_refresh_tokens",
  "oauth_access_tokens",
  "oauth_consents",
  "oauth_client_assertions",
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
    for (const table of TABLES) {
      const { rows } = await client.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${table}`]);
      console.log(`${table} ${rows[0]?.present ? "present" : "MISSING"}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
