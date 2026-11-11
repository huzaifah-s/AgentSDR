import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxCredentials, mailboxes, type ImapCursor } from "./schema";
import { testMailboxConnection } from "./gmail";
import { loadImapSmtpLogin, saveImapSmtpLogin, testImapSmtpLogin, type ImapSmtpLogin } from "./imapSmtp";
import { ImapSmtpInputError, parseImapSmtpInput, type ImapSmtpInput } from "./imapSmtpConfig";
import { channelRules } from "@/lib/channels/rules.server";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { mailboxHoursFromWeekly } from "./workingHours";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

export async function listMailboxes() {
  return db.select().from(mailboxes).where(inOrg(mailboxes)).orderBy(mailboxes.createdAt);
}

/**
 * Whether this organization can use email at all: Google Workspace is
 * connected, or it has an SMTP + IMAP mailbox (which needs no integration).
 * What the Email section waits on.
 */
export async function hasEmailSender(): Promise<boolean> {
  if (await isPlatformConnected("google")) return true;
  const [imap] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(inOrg(mailboxes), eq(mailboxes.provider, "imap")))
    .limit(1);
  return Boolean(imap);
}

export async function getMailbox(id: string) {
  const [row] = await db.select().from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, id))).limit(1);
  return row ?? null;
}

export type ConnectMailboxResult =
  | { ok: true; mailboxId: string; status: "connected" }
  | { ok: false; error: string };

type ConnectMailboxInput = {
  emailAddress: string;
  displayName?: string | null;
  /** Undefined leaves any existing signature untouched (e.g. on a retest); pass "" to explicitly clear it. */
  signatureHtml?: string | null;
  /** How it sends and reads mail. Defaults to Google Workspace. */
  provider?: "google" | "imap";
  /** SMTP + IMAP servers and login; required when `provider` is "imap". */
  imapSmtp?: ImapSmtpInput;
};

/** The address normalised, the organization's row for it, or why it cannot be added here. */
async function findMailboxForConnect(rawAddress: string) {
  const emailAddress = rawAddress.trim().toLowerCase();
  if (!emailAddress || !emailAddress.includes("@")) {
    return { error: `invalid email: "${rawAddress}"` } as const;
  }
  const [existing] = await db
    .select()
    .from(mailboxes)
    .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, emailAddress)))
    .limit(1);
  if (!existing) {
    // A mailbox belongs to exactly one organization (email_address is
    // globally unique), so one already connected elsewhere cannot be added.
    const [elsewhere] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.emailAddress, emailAddress))
      .limit(1);
    if (elsewhere) return { error: `${emailAddress} is already connected to another organization` } as const;
  }
  return { emailAddress, existing: existing ?? null } as const;
}

/**
 * Adds (or re-tests) a mailbox. A Google Workspace one: stores the row, calls
 * Gmail to verify our service account can actually impersonate this address,
 * then records the outcome — no OAuth screen, no password. An SMTP + IMAP one:
 * see connectImapMailbox.
 */
export async function connectMailbox(input: ConnectMailboxInput): Promise<ConnectMailboxResult> {
  if (input.provider === "imap") return connectImapMailbox(input);

  const found = await findMailboxForConnect(input.emailAddress);
  if ("error" in found) return { ok: false, error: found.error! };
  const { emailAddress, existing } = found;

  // A new mailbox starts from the organization's sending rules; after that its
  // own limit and hours are edited per mailbox.
  const rules = existing ? null : await channelRules("email");
  const mailboxId =
    existing?.id ??
    (
      await db
        .insert(mailboxes)
        .values({
          organizationId: currentOrganizationId(),
          emailAddress,
          displayName: input.displayName?.trim() || null,
          signatureHtml: input.signatureHtml?.trim() || null,
          status: "connecting",
          dailySendLimit: rules!.dailySendLimit,
          workingHours: mailboxHoursFromWeekly(rules!.sendingHours),
        })
        .returning({ id: mailboxes.id })
    )[0].id;

  const test = await testMailboxConnection(emailAddress);

  if (test.ok) {
    await db
      .update(mailboxes)
      .set({
        status: "connected",
        lastError: null,
        lastTestedAt: new Date(),
        lastHistoryId: test.historyId,
        provider: "google",
        imapCursor: null,
        displayName: input.displayName?.trim() || existing?.displayName || null,
        ...(input.signatureHtml !== undefined ? { signatureHtml: input.signatureHtml?.trim() || null } : {}),
        updatedAt: new Date(),
      })
      .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
    // It no longer sends with a login of its own; don't keep the password.
    await db.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mailboxId));
    return { ok: true, mailboxId, status: "connected" };
  }

  await db
    .update(mailboxes)
    .set({ status: "failed", lastError: test.error, lastTestedAt: new Date(), updatedAt: new Date() })
    .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
  return { ok: false, error: test.error };
}

/**
 * Where reply sync continues after a (re)test: the stored position while the
 * server's numbering is unchanged, so mail that arrived in between is still
 * read; otherwise the test's, which starts from now.
 */
function cursorAfterTest(stored: ImapCursor | null | undefined, tested: ImapCursor): ImapCursor {
  return stored && stored.uidValidity === tested.uidValidity ? stored : tested;
}

/**
 * Adds an SMTP + IMAP mailbox, or updates one's servers or password. Both
 * servers are tested before anything is saved: a new mailbox that fails is
 * not added, and a failed change leaves a working mailbox as it was (a typo
 * in a new password must not stop its campaigns). The password may be left
 * out when updating a mailbox that has one.
 */
async function connectImapMailbox(input: ConnectMailboxInput): Promise<ConnectMailboxResult> {
  const found = await findMailboxForConnect(input.emailAddress);
  if ("error" in found) return { ok: false, error: found.error! };
  const { emailAddress, existing } = found;

  const stored = existing?.provider === "imap" ? await loadImapSmtpLogin(existing.id) : null;
  let parsed;
  try {
    parsed = parseImapSmtpInput(input.imapSmtp ?? {}, { requirePassword: !stored });
  } catch (err) {
    if (err instanceof ImapSmtpInputError) return { ok: false, error: err.message };
    throw err;
  }
  const password = parsed.password ?? stored?.password;
  if (!password) return { ok: false, error: "Password is required" };
  const login: ImapSmtpLogin = { settings: { ...parsed.settings, sentFolder: null }, password };

  const test = await testImapSmtpLogin(login, { saveToSent: parsed.saveToSent });
  if (!test.ok) return { ok: false, error: test.error };
  login.settings.sentFolder = test.sentFolder;

  const now = new Date();
  const displayName = input.displayName?.trim() || existing?.displayName || null;
  let mailboxId: string;
  if (existing) {
    mailboxId = existing.id;
    await db
      .update(mailboxes)
      .set({
        provider: "imap",
        status: "connected",
        lastError: null,
        lastTestedAt: now,
        lastHistoryId: null,
        imapCursor: cursorAfterTest(existing.provider === "imap" ? existing.imapCursor : null, test.cursor),
        displayName,
        ...(input.signatureHtml !== undefined ? { signatureHtml: input.signatureHtml?.trim() || null } : {}),
        updatedAt: now,
      })
      .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
  } else {
    const rules = await channelRules("email");
    [{ id: mailboxId }] = await db
      .insert(mailboxes)
      .values({
        organizationId: currentOrganizationId(),
        emailAddress,
        provider: "imap",
        displayName,
        signatureHtml: input.signatureHtml?.trim() || null,
        status: "connected",
        lastTestedAt: now,
        imapCursor: test.cursor,
        dailySendLimit: rules.dailySendLimit,
        workingHours: mailboxHoursFromWeekly(rules.sendingHours),
      })
      .returning({ id: mailboxes.id });
  }
  await saveImapSmtpLogin(mailboxId, login);
  return { ok: true, mailboxId, status: "connected" };
}

/** Re-runs the connection test for an already-added mailbox. Leaves its signature untouched. */
export async function retestMailbox(id: string): Promise<ConnectMailboxResult> {
  const mailbox = await getMailbox(id);
  if (!mailbox) return { ok: false, error: "mailbox not found" };
  if (mailbox.provider !== "imap") {
    return connectMailbox({ emailAddress: mailbox.emailAddress, displayName: mailbox.displayName });
  }

  // An IMAP mailbox is retested with its stored login; a failure marks it
  // failed (nothing sends from it) until a retest or new password passes.
  const login = await loadImapSmtpLogin(mailbox.id);
  const test = login
    ? await testImapSmtpLogin(login, { saveToSent: login.settings.sentFolder !== null })
    : { ok: false as const, error: "No SMTP login is saved for this mailbox — add it again with its password" };
  const now = new Date();
  if (!test.ok) {
    await db
      .update(mailboxes)
      .set({ status: "failed", lastError: test.error, lastTestedAt: now, updatedAt: now })
      .where(and(inOrg(mailboxes), eq(mailboxes.id, mailbox.id)));
    return { ok: false, error: test.error };
  }
  await db
    .update(mailboxes)
    .set({
      status: "connected",
      lastError: null,
      lastTestedAt: now,
      imapCursor: cursorAfterTest(mailbox.imapCursor, test.cursor),
      updatedAt: now,
    })
    .where(and(inOrg(mailboxes), eq(mailboxes.id, mailbox.id)));
  if (login && test.sentFolder !== login.settings.sentFolder && login.settings.sentFolder !== null) {
    await saveImapSmtpLogin(mailbox.id, { ...login, settings: { ...login.settings, sentFolder: test.sentFolder } });
  }
  return { ok: true, mailboxId: mailbox.id, status: "connected" };
}

export async function deleteMailbox(id: string) {
  await db.delete(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, id)));
}
