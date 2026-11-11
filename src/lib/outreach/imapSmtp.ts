/**
 * SMTP + IMAP mailboxes (`provider = 'imap'`): any provider that offers the
 * two standard protocols — Zoho, Fastmail, Yahoo, iCloud, cPanel and other
 * hosting, a company's own mail server, even Gmail with an app password.
 *
 * SMTP sends; IMAP reads replies from INBOX (polled, see imapSync.ts) and
 * files a copy of each send in Sent, which SMTP alone never does. The login
 * is the mailbox's own (usually an app password), stored encrypted in
 * outreach_mailbox_credentials.
 *
 * The servers are named by whoever adds the mailbox, so a host that resolves
 * to a loopback, private, link-local or CGNAT address is refused (the same
 * rule as the table HTTP column), and the connection goes to the address that
 * was checked — not a second lookup — with the host name kept for TLS.
 * Self-hosters whose mail server is on their own network set
 * EMAIL_ALLOW_PRIVATE_HOSTS=true.
 */
import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, eq, inArray } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";

import { db } from "@/lib/db";
import type { EmailAddress } from "@/lib/email/recipients";
import { decryptCredentialText, encryptCredentialText } from "@/lib/integrations/credential-crypto";
import { isBlockedAddress } from "@/lib/grid/runners/http";
import { inOrg } from "@/lib/tenancy/scope";
import { buildRawEmailMessage, type InboundMessage, type SendEmailParams, type SendEmailResult } from "./gmail";
import { inboundThreadRoot, newMessageId, parseMessageIdList, smtpSendThreadId } from "./emailThreading";
import { mailboxCredentials, mailboxes, type ImapCursor, type ImapSmtpSettings } from "./schema";

const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 60_000;

export type ImapSmtpLogin = { settings: ImapSmtpSettings; password: string };

export class MailServerAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailServerAddressError";
  }
}

type Resolver = (host: string) => Promise<string[]>;
const resolveAll: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * The address to connect to for `host`, after refusing internal ones.
 * Returns the host itself when private addresses are allowed.
 */
export async function resolveMailHost(
  host: string,
  resolve: Resolver = resolveAll,
  allowPrivate = process.env.EMAIL_ALLOW_PRIVATE_HOSTS === "true",
): Promise<{ address: string; servername: string | undefined }> {
  if (allowPrivate) return { address: host, servername: undefined };
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new MailServerAddressError(`Could not find the server ${host} — check the spelling`);
    }
  }
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new MailServerAddressError(
      `${host} is a private or internal address. Self-hosted deployments can allow it with EMAIL_ALLOW_PRIVATE_HOSTS=true.`,
    );
  }
  return { address: addresses[0], servername: isIP(host) ? undefined : host };
}

// ---------------------------------------------------------------------------
// Stored login
// ---------------------------------------------------------------------------

/** The login of an IMAP mailbox of the current organization, or null. */
export async function loadImapSmtpLogin(mailboxId: string): Promise<ImapSmtpLogin | null> {
  const [row] = await db
    .select({ settings: mailboxCredentials.settings, encryptedSecret: mailboxCredentials.encryptedSecret })
    .from(mailboxCredentials)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxCredentials.mailboxId))
    .where(and(inOrg(mailboxes), eq(mailboxCredentials.mailboxId, mailboxId)))
    .limit(1);
  if (!row) return null;
  const secret = JSON.parse(decryptCredentialText(row.encryptedSecret)) as { password?: unknown };
  if (typeof secret.password !== "string") throw new Error("Stored mailbox password is invalid");
  return { settings: row.settings, password: secret.password };
}

/** Saves (or replaces) an IMAP mailbox's login. The caller has checked the mailbox is in scope. */
export async function saveImapSmtpLogin(mailboxId: string, login: ImapSmtpLogin) {
  const encryptedSecret = encryptCredentialText(JSON.stringify({ password: login.password }));
  await db
    .insert(mailboxCredentials)
    .values({ mailboxId, settings: login.settings, encryptedSecret })
    .onConflictDoUpdate({
      target: mailboxCredentials.mailboxId,
      set: { settings: login.settings, encryptedSecret, updatedAt: new Date() },
    });
}

/** The server settings (no password) of IMAP mailboxes, for the UI. */
export async function listImapSmtpSettings(mailboxIds: string[]): Promise<Map<string, ImapSmtpSettings>> {
  if (mailboxIds.length === 0) return new Map();
  const rows = await db
    .select({ mailboxId: mailboxCredentials.mailboxId, settings: mailboxCredentials.settings })
    .from(mailboxCredentials)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxCredentials.mailboxId))
    .where(and(inOrg(mailboxes), inArray(mailboxCredentials.mailboxId, mailboxIds)));
  return new Map(rows.map((row) => [row.mailboxId, row.settings]));
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

async function smtpTransport(login: ImapSmtpLogin) {
  const { settings, password } = login;
  const target = await resolveMailHost(settings.smtpHost);
  return nodemailer.createTransport({
    host: target.address,
    port: settings.smtpPort,
    secure: settings.smtpSecurity === "tls",
    // Never send a password over a connection that did not upgrade.
    requireTLS: settings.smtpSecurity === "starttls",
    auth: { user: settings.username, pass: password },
    tls: target.servername ? { servername: target.servername } : undefined,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
}

async function withImap<T>(login: ImapSmtpLogin, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const { settings, password } = login;
  const target = await resolveMailHost(settings.imapHost);
  const client = new ImapFlow({
    host: target.address,
    servername: target.servername,
    port: settings.imapPort,
    secure: settings.imapSecurity === "tls",
    // imapflow upgrades with STARTTLS when offered; refuse a server that does not.
    doSTARTTLS: settings.imapSecurity === "starttls" ? true : undefined,
    auth: { user: settings.username, pass: password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
  // A socket error after connect is reported here; without a listener it would crash the process.
  client.on("error", (err: unknown) => console.error(`[outreach/imap] ${settings.imapHost}:`, err instanceof Error ? err.message : err));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Socket-level failures: nothing answered, or not the protocol we expected (nodemailer's ESOCKET/ECONNECTION, Node's own codes). */
const UNREACHABLE = new Set(["ETIMEDOUT", "ECONNECTION", "ECONNREFUSED", "ECONNRESET", "ESOCKET", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EPROTO"]);

/** A readable reason from an SMTP/IMAP failure: servers put the useful part in `response`. */
export function mailServerErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const detail = err as Error & { response?: string; responseText?: string; authenticationFailed?: boolean; code?: string };
  if (detail.authenticationFailed) return "The server refused the username or password (many providers need an app password here)";
  if (detail.code === "EAUTH") return `The server refused the username or password${detail.response ? `: ${detail.response}` : ""}`;
  if (detail.code && UNREACHABLE.has(detail.code)) {
    const reason = detail.message?.trim() || detail.code;
    return `Could not reach the server (${reason}) — check the host, port and security`;
  }
  return detail.responseText || detail.response || detail.message || detail.code || "Unknown error";
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

export type ImapSmtpTest =
  | { ok: true; cursor: ImapCursor; sentFolder: string | null }
  | { ok: false; error: string };

/**
 * Logs in to both servers without sending anything: SMTP authenticates
 * (`verify`), IMAP opens INBOX for its position — where reply sync starts, so
 * older mail is not read as new replies — and looks for the Sent folder.
 */
export async function testImapSmtpLogin(login: ImapSmtpLogin, options: { saveToSent: boolean }): Promise<ImapSmtpTest> {
  try {
    const transport = await smtpTransport(login);
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  } catch (err) {
    return { ok: false, error: `SMTP (sending): ${err instanceof MailServerAddressError ? err.message : mailServerErrorMessage(err)}` };
  }

  try {
    return await withImap(login, async (client) => {
      const status = await client.status("INBOX", { uidValidity: true, uidNext: true });
      if (!status || status.uidValidity === undefined || status.uidNext === undefined) {
        return { ok: false as const, error: "IMAP (replies): the server did not report the INBOX position" };
      }
      let sentFolder: string | null = null;
      if (options.saveToSent) {
        const folders = await client.list();
        sentFolder = folders.find((folder) => folder.specialUse === "\\Sent")?.path ?? null;
      }
      return {
        ok: true as const,
        cursor: { uidValidity: status.uidValidity.toString(), lastUid: Math.max(0, status.uidNext - 1) },
        sentFolder,
      };
    });
  } catch (err) {
    return { ok: false, error: `IMAP (replies): ${err instanceof MailServerAddressError ? err.message : mailServerErrorMessage(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Sends one email over SMTP. The Message-ID is ours (so threading works
 * without a read-back) and the thread is named by its root Message-ID
 * (emailThreading.ts). Bcc recipients go in the envelope only. A failure to
 * file the copy in Sent is logged and never fails the send — the mail is out.
 */
export async function sendSmtpEmail(login: ImapSmtpLogin, params: SendEmailParams): Promise<SendEmailResult> {
  const messageId = newMessageId(params.from);
  const raw = await buildRawEmailMessage(params, { keepBcc: false, messageId });
  const transport = await smtpTransport(login);
  try {
    const info = await transport.sendMail({
      envelope: { from: params.from, to: [...params.to, ...(params.cc ?? []), ...(params.bcc ?? [])] },
      raw,
    });
    if (info.rejected?.length && !info.accepted?.length) {
      throw new Error(`The SMTP server rejected every recipient: ${info.rejected.join(", ")}`);
    }
  } finally {
    transport.close();
  }

  const sentFolder = login.settings.sentFolder;
  if (sentFolder) {
    try {
      // The Sent copy keeps Bcc, as a mail client's would.
      const copy = params.bcc?.length ? await buildRawEmailMessage(params, { keepBcc: true, messageId }) : raw;
      await withImap(login, (client) => client.append(sentFolder, copy, ["\\Seen"]));
    } catch (err) {
      console.error(`[outreach/smtp] sent ${messageId} but could not file it in ${sentFolder}:`, mailServerErrorMessage(err));
    }
  }

  return { id: messageId, messageId, threadId: smtpSendThreadId(params, messageId) };
}

// ---------------------------------------------------------------------------
// Reading replies
// ---------------------------------------------------------------------------

function addresses(value: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .flatMap((group) => group.value)
    .flatMap((entry) => (entry.group ? entry.group : [entry]))
    .filter((entry) => entry.address)
    .map((entry) => ({ email: entry.address!.toLowerCase(), name: entry.name?.trim() || null }));
}

/** The text a reply bridge reads: plain text, else HTML, plus a delivery report's machine part. */
function bodyTextOf(parsed: ParsedMail): string | null {
  const text = parsed.text?.trim() ? parsed.text : typeof parsed.html === "string" ? parsed.html : null;
  // A bounce's "Final-Recipient: rfc822; …" lives in a message/delivery-status
  // part, which the parser files as an attachment.
  const report = parsed.attachments
    .filter((part) => part.contentType === "message/delivery-status")
    .map((part) => part.content.toString("utf8"))
    .join("\n");
  return [text, report].filter(Boolean).join("\n\n") || null;
}

/**
 * One raw IMAP message as the reply bridge's InboundMessage, with its whole
 * References chain (the sync looks for a known thread among them). Exported
 * for tests.
 */
export async function parseImapMessage(
  source: Buffer,
  uid: number,
  uidValidity: string,
  internalDate?: Date | null,
): Promise<{ message: InboundMessage; references: string[] }> {
  const parsed = await simpleParser(source);
  const from = addresses(parsed.from)[0];
  const to = addresses(parsed.to);
  const cc = addresses(parsed.cc);
  const messageId = parsed.messageId ? parseMessageIdList(parsed.messageId)[0] ?? null : null;
  const references = parseMessageIdList(parsed.references);
  const inReplyTo = parsed.inReplyTo ? parseMessageIdList(parsed.inReplyTo)[0] ?? null : null;
  const message: InboundMessage = {
    source: "imap",
    gmailMessageId: messageId ?? `uid:${uidValidity}:${uid}`,
    threadId: inboundThreadRoot({ references, inReplyTo, messageId }).root,
    fromEmail: from?.email ?? null,
    fromName: from?.name ?? null,
    toEmail: to[0]?.email ?? null,
    to,
    cc,
    replyTo: addresses(parsed.replyTo),
    ccEmails: cc.map((a) => a.email),
    subject: parsed.subject ?? null,
    bodyText: bodyTextOf(parsed),
    messageId,
    inReplyTo,
    internalDate: parsed.date ?? internalDate ?? null,
  };
  return { message, references };
}

export type ImapFetchResult = {
  /** Oldest first, each with its UID so the caller can advance the cursor one message at a time. */
  messages: { uid: number; message: InboundMessage; references: string[] }[];
  /** The cursor after these messages (or a fresh one when the mailbox was renumbered). */
  cursor: ImapCursor;
  /** INBOX was renumbered (UIDVALIDITY changed): sync restarts from now, nothing is fetched. */
  reset: boolean;
  /** More messages wait beyond `limit`. */
  more: boolean;
};

/**
 * Messages that arrived in INBOX after `cursor`, at most `limit`, oldest
 * first. INBOX is opened read-only, so nothing is marked as read.
 */
export async function fetchNewImapMessages(login: ImapSmtpLogin, cursor: ImapCursor, limit = 25): Promise<ImapFetchResult> {
  return withImap(login, async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const box = client.mailbox;
      if (!box) throw new Error("INBOX did not open");
      const uidValidity = box.uidValidity.toString();
      if (uidValidity !== cursor.uidValidity) {
        return { messages: [], cursor: { uidValidity, lastUid: Math.max(0, box.uidNext - 1) }, reset: true, more: false };
      }
      if (box.uidNext <= cursor.lastUid + 1) return { messages: [], cursor, reset: false, more: false };

      // `n:*` always includes the newest message even when its UID is below n, hence the filter.
      const found: { uid: number; source: Buffer; internalDate: Date | null }[] = [];
      for await (const msg of client.fetch(`${cursor.lastUid + 1}:*`, { uid: true, source: true, internalDate: true }, { uid: true })) {
        if (msg.uid > cursor.lastUid && msg.source) {
          const date = msg.internalDate ? new Date(msg.internalDate) : null;
          found.push({ uid: msg.uid, source: msg.source, internalDate: date && !Number.isNaN(date.getTime()) ? date : null });
        }
      }
      found.sort((a, b) => a.uid - b.uid);
      const batch = found.slice(0, limit);
      const messages = [];
      for (const item of batch) {
        messages.push({ uid: item.uid, ...(await parseImapMessage(item.source, item.uid, uidValidity, item.internalDate)) });
      }
      return {
        messages,
        cursor: { uidValidity, lastUid: batch.at(-1)?.uid ?? cursor.lastUid },
        reset: false,
        more: found.length > batch.length,
      };
    } finally {
      lock.release();
    }
  });
}
