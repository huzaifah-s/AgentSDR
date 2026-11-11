/**
 * SMTP + IMAP mailboxes: the provider presets the connect form offers and the
 * validation of what it submits. Pure and client-safe — the connection itself
 * is in imapSmtp.ts.
 */
import type { ImapSmtpSettings } from "./schema";

export type ImapSmtpPreset = {
  key: string;
  name: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "tls" | "starttls";
  imapHost: string;
  imapPort: number;
  imapSecurity: "tls" | "starttls";
  /** Shown under the password field: most of these need an app password, not the account's own. */
  passwordHint: string;
  /** The server already files every SMTP send in Sent, so AgentSDR must not save a second copy. */
  serverSavesSent?: boolean;
};

/**
 * Microsoft 365 / Outlook is deliberately absent: Microsoft is retiring
 * password sign-in for SMTP and IMAP, so it needs its own OAuth connection.
 */
export const IMAP_SMTP_PRESETS: readonly ImapSmtpPreset[] = [
  {
    key: "zoho",
    name: "Zoho Mail",
    smtpHost: "smtp.zoho.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    imapHost: "imap.zoho.com",
    imapPort: 993,
    imapSecurity: "tls",
    passwordHint: "With two-factor sign-in on, use an app-specific password (Zoho Accounts → Security → App passwords). IMAP access must be on in Zoho Mail settings.",
  },
  {
    key: "fastmail",
    name: "Fastmail",
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    imapSecurity: "tls",
    passwordHint: "An app password with IMAP and SMTP access (Settings → Privacy & Security → App passwords).",
  },
  {
    key: "gmail",
    name: "Gmail (app password)",
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecurity: "tls",
    passwordHint: "A 16-character app password (Google Account → Security → App passwords; needs 2-Step Verification). For a whole Workspace domain, the Google Workspace connection is simpler.",
    serverSavesSent: true,
  },
  {
    key: "yahoo",
    name: "Yahoo Mail",
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    imapSecurity: "tls",
    passwordHint: "An app password (Account security → Generate app password).",
  },
  {
    key: "icloud",
    name: "iCloud Mail",
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    imapSecurity: "tls",
    passwordHint: "An app-specific password from appleid.apple.com. The username is the full iCloud address.",
  },
  {
    key: "godaddy",
    name: "GoDaddy Professional Email",
    smtpHost: "smtpout.secureserver.net",
    smtpPort: 465,
    smtpSecurity: "tls",
    imapHost: "imap.secureserver.net",
    imapPort: 993,
    imapSecurity: "tls",
    passwordHint: "The mailbox's own password.",
  },
];

export function imapSmtpPreset(key: string | null | undefined): ImapSmtpPreset | null {
  return IMAP_SMTP_PRESETS.find((preset) => preset.key === key) ?? null;
}

/** What the connect form submits for an SMTP + IMAP mailbox. */
export type ImapSmtpInput = {
  smtpHost?: unknown;
  smtpPort?: unknown;
  smtpSecurity?: unknown;
  imapHost?: unknown;
  imapPort?: unknown;
  imapSecurity?: unknown;
  username?: unknown;
  /** Omitted when updating a mailbox's settings without changing its password. */
  password?: unknown;
  /** True: AgentSDR saves a copy of each send to the Sent folder over IMAP. */
  saveToSent?: unknown;
};

export type ParsedImapSmtpInput = {
  settings: Omit<ImapSmtpSettings, "sentFolder">;
  password: string | null;
  saveToSent: boolean;
};

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

function hostField(value: unknown, label: string): string {
  const host = typeof value === "string" ? value.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!host) throw new ImapSmtpInputError(`${label} is required`);
  if (!HOSTNAME.test(host)) throw new ImapSmtpInputError(`${label} must be a host name such as mail.example.com, without a scheme or port`);
  return host;
}

function portField(value: unknown, label: string): number {
  const port = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ImapSmtpInputError(`${label} must be a number from 1 to 65535`);
  }
  return port;
}

function securityField(value: unknown, port: number): "tls" | "starttls" {
  if (value === "tls" || value === "starttls") return value;
  if (value === undefined || value === null || value === "") return port === 465 || port === 993 ? "tls" : "starttls";
  throw new ImapSmtpInputError(`Security must be "tls" or "starttls"`);
}

export class ImapSmtpInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapSmtpInputError";
  }
}

/**
 * Validates the SMTP + IMAP part of a connect request. `requirePassword` is
 * false when the mailbox already has a stored password the request may keep.
 * Plain-text connections are never offered: "starttls" refuses a server that
 * cannot upgrade.
 */
export function parseImapSmtpInput(input: ImapSmtpInput, options: { requirePassword: boolean }): ParsedImapSmtpInput {
  const smtpPort = portField(input.smtpPort, "SMTP port");
  const imapPort = portField(input.imapPort, "IMAP port");
  const username = typeof input.username === "string" ? input.username.trim() : "";
  if (!username) throw new ImapSmtpInputError("Username is required");
  if (username.length > 320) throw new ImapSmtpInputError("Username is too long");
  const password = typeof input.password === "string" && input.password.length > 0 ? input.password : null;
  if (!password && options.requirePassword) throw new ImapSmtpInputError("Password is required");
  if (password && password.length > 1024) throw new ImapSmtpInputError("Password is too long");
  return {
    settings: {
      smtpHost: hostField(input.smtpHost, "SMTP server"),
      smtpPort,
      smtpSecurity: securityField(input.smtpSecurity, smtpPort),
      imapHost: hostField(input.imapHost, "IMAP server"),
      imapPort,
      imapSecurity: securityField(input.imapSecurity, imapPort),
      username,
    },
    password,
    saveToSent: input.saveToSent === undefined ? true : input.saveToSent === true || input.saveToSent === "true",
  };
}
