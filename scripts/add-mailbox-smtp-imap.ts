/**
 * Mailboxes on any provider: SMTP sends, IMAP reads replies.
 *
 * - outreach_mailboxes.provider — 'google' (Google Workspace service account;
 *   every mailbox before this) or 'imap' (SMTP + IMAP with the mailbox's own
 *   login).
 * - outreach_mailboxes.imap_cursor — where reply sync left off in INBOX:
 *   { uidValidity, lastUid }. Gmail mailboxes keep last_history_id instead.
 * - outreach_mailbox_credentials — one row per IMAP mailbox: the server
 *   settings in the clear (hosts, ports, username, Sent folder) and the
 *   password encrypted with INTEGRATION_CREDENTIALS_KEY, like every other
 *   integration. Inherits its organization through the mailbox.
 *
 * Matches src/lib/outreach/schema.ts. Run with:
 *   bun run scripts/add-mailbox-smtp-imap.ts
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
    await client.query(`ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'google'`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_mailboxes_provider_chk') THEN
          ALTER TABLE outreach_mailboxes ADD CONSTRAINT outreach_mailboxes_provider_chk CHECK (provider IN ('google', 'imap'));
        END IF;
      END $$`);
    await client.query(`ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS imap_cursor jsonb`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS outreach_mailbox_credentials (
        mailbox_id uuid PRIMARY KEY NOT NULL REFERENCES outreach_mailboxes(id) ON DELETE CASCADE,
        settings jsonb NOT NULL,
        encrypted_secret text NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      )`);
    console.log("outreach_mailboxes.provider, .imap_cursor and outreach_mailbox_credentials ready");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
