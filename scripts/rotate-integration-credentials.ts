/**
 * Re-encrypts integration credentials with INTEGRATION_CREDENTIALS_KEY:
 * grid_provider_credentials and the SMTP + IMAP mailbox passwords in
 * outreach_mailbox_credentials (same key, same format).
 *
 * Dry-run (default):
 *   LEGACY_INTEGRATION_CREDENTIALS_KEYS=... bun run scripts/rotate-integration-credentials.ts
 *
 * Apply:
 *   LEGACY_INTEGRATION_CREDENTIALS_KEYS=... bun run scripts/rotate-integration-credentials.ts --apply
 *
 * AUTH_SECRET is automatically included as a legacy key. Multiple additional
 * legacy keys may be supplied as a comma-separated list. Secret values and
 * decrypted credential values are never logged.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Client } from "pg";

const FORMAT_VERSION = "v1";
const IV_BYTES = 12;
const APPLY = process.argv.includes("--apply");

type CredentialRow = {
  id: string;
  provider_id: string;
  integration_key: string;
  provider_name: string;
  encrypted_payload: string;
};

type CredentialObject = Record<string, string>;

function derivedKey(secret: string): Buffer {
  return createHash("sha256")
    .update("agentsdr:integration-credentials:v1:")
    .update(secret)
    .digest();
}

function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

function decrypt(payload: string, secret: string): string {
  const [version, ivPart, tagPart, encryptedPart] = payload.split(".");
  if (version !== FORMAT_VERSION || !ivPart || !tagPart || !encryptedPart) {
    throw new Error("Unsupported credential payload format");
  }
  const decipher = createDecipheriv("aes-256-gcm", derivedKey(secret), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function encrypt(plaintext: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function validateCredentialJson(plaintext: string): CredentialObject {
  const parsed: unknown = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Decrypted credential payload is not an object");
  }
  if (Object.entries(parsed).some(([key, value]) => !key || typeof value !== "string")) {
    throw new Error("Decrypted credential payload contains an invalid field");
  }
  return parsed as CredentialObject;
}

function tryDecrypt(payload: string, secret: string): CredentialObject | null {
  try {
    return validateCredentialJson(decrypt(payload, secret));
  } catch {
    return null;
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const targetSecret = process.env.INTEGRATION_CREDENTIALS_KEY;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (!targetSecret) throw new Error("INTEGRATION_CREDENTIALS_KEY is required");
  if (targetSecret.length < 32) throw new Error("INTEGRATION_CREDENTIALS_KEY must be at least 32 characters");

  const additionalLegacy = (process.env.LEGACY_INTEGRATION_CREDENTIALS_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const legacySecrets = [...new Set([process.env.AUTH_SECRET, ...additionalLegacy].filter((value): value is string => Boolean(value)))]
    .filter((value) => value !== targetSecret);
  if (!legacySecrets.length) throw new Error("At least one legacy key is required via AUTH_SECRET or LEGACY_INTEGRATION_CREDENTIALS_KEYS");

  console.log(JSON.stringify({
    mode: APPLY ? "apply" : "dry-run",
    targetKeyFingerprint: fingerprint(targetSecret),
    legacyKeyFingerprints: legacySecrets.map(fingerprint),
  }));

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const summary = { total: 0, alreadyCurrent: 0, rotatable: 0, rotated: 0, unresolved: 0 };
  const results: Array<Record<string, unknown>> = [];

  try {
    await client.query("BEGIN");
    const { rows } = await client.query<CredentialRow>(`
      SELECT
        c.id,
        c.provider_id,
        p.config->>'integrationKey' AS integration_key,
        p.name AS provider_name,
        c.encrypted_payload
      FROM grid_provider_credentials c
      JOIN grid_providers p ON p.id = c.provider_id
      WHERE p.config ? 'integrationKey'
      ORDER BY p.created_at
      FOR UPDATE OF c
    `);
    summary.total = rows.length;

    for (const row of rows) {
      const current = tryDecrypt(row.encrypted_payload, targetSecret);
      if (current) {
        summary.alreadyCurrent += 1;
        results.push({ integration: row.integration_key, account: row.provider_name, status: "already_current" });
        continue;
      }

      let credentials: CredentialObject | null = null;
      let sourceKeyFingerprint: string | null = null;
      for (const secret of legacySecrets) {
        credentials = tryDecrypt(row.encrypted_payload, secret);
        if (credentials) {
          sourceKeyFingerprint = fingerprint(secret);
          break;
        }
      }
      if (!credentials) {
        summary.unresolved += 1;
        results.push({ integration: row.integration_key, account: row.provider_name, status: "unresolved" });
        continue;
      }

      summary.rotatable += 1;
      const plaintext = JSON.stringify(credentials);
      const rotatedPayload = encrypt(plaintext, targetSecret);
      const verification = tryDecrypt(rotatedPayload, targetSecret);
      if (!verification || JSON.stringify(verification) !== plaintext) {
        throw new Error(`Round-trip verification failed for provider ${row.provider_id}`);
      }
      if (APPLY) {
        await client.query(
          `UPDATE grid_provider_credentials
           SET encrypted_payload = $1, encryption_version = $2, updated_at = now()
           WHERE id = $3`,
          [rotatedPayload, FORMAT_VERSION, row.id],
        );
        summary.rotated += 1;
      }
      results.push({
        integration: row.integration_key,
        account: row.provider_name,
        status: APPLY ? "rotated" : "rotatable",
        sourceKeyFingerprint,
      });
    }

    // SMTP + IMAP mailbox logins (scripts/add-mailbox-smtp-imap.ts). The table
    // may not exist yet on a database that predates it.
    const { rows: mailboxTable } = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('outreach_mailbox_credentials') IS NOT NULL AS exists`,
    );
    const mailboxRows = mailboxTable[0]?.exists
      ? (await client.query<{ mailbox_id: string; email_address: string; encrypted_secret: string }>(`
          SELECT c.mailbox_id, m.email_address, c.encrypted_secret
          FROM outreach_mailbox_credentials c
          JOIN outreach_mailboxes m ON m.id = c.mailbox_id
          ORDER BY m.created_at
          FOR UPDATE OF c
        `)).rows
      : [];
    summary.total += mailboxRows.length;
    for (const row of mailboxRows) {
      if (tryDecrypt(row.encrypted_secret, targetSecret)) {
        summary.alreadyCurrent += 1;
        results.push({ integration: "mailbox-smtp-imap", account: row.email_address, status: "already_current" });
        continue;
      }
      let credentials: CredentialObject | null = null;
      let sourceKeyFingerprint: string | null = null;
      for (const secret of legacySecrets) {
        credentials = tryDecrypt(row.encrypted_secret, secret);
        if (credentials) {
          sourceKeyFingerprint = fingerprint(secret);
          break;
        }
      }
      if (!credentials) {
        summary.unresolved += 1;
        results.push({ integration: "mailbox-smtp-imap", account: row.email_address, status: "unresolved" });
        continue;
      }
      summary.rotatable += 1;
      const plaintext = JSON.stringify(credentials);
      const rotatedPayload = encrypt(plaintext, targetSecret);
      const verification = tryDecrypt(rotatedPayload, targetSecret);
      if (!verification || JSON.stringify(verification) !== plaintext) {
        throw new Error(`Round-trip verification failed for mailbox ${row.mailbox_id}`);
      }
      if (APPLY) {
        await client.query(
          `UPDATE outreach_mailbox_credentials SET encrypted_secret = $1, updated_at = now() WHERE mailbox_id = $2`,
          [rotatedPayload, row.mailbox_id],
        );
        summary.rotated += 1;
      }
      results.push({ integration: "mailbox-smtp-imap", account: row.email_address, status: APPLY ? "rotated" : "rotatable", sourceKeyFingerprint });
    }

    if (APPLY) await client.query("COMMIT");
    else await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }

  console.log(JSON.stringify({ summary, results }, null, 2));
}

await main();
