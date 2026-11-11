import { describe, expect, test } from "bun:test";

import { IMAP_SMTP_PRESETS, ImapSmtpInputError, parseImapSmtpInput } from "./imapSmtpConfig";

const valid = {
  smtpHost: " SMTP.Zoho.com. ",
  smtpPort: 465,
  imapHost: "imap.zoho.com",
  imapPort: "993",
  username: " rep@acme.io ",
  password: "app-password",
};

describe("parseImapSmtpInput", () => {
  test("normalises hosts and usernames and infers security from the port", () => {
    const parsed = parseImapSmtpInput(valid, { requirePassword: true });
    expect(parsed.settings).toEqual({
      smtpHost: "smtp.zoho.com",
      smtpPort: 465,
      smtpSecurity: "tls",
      imapHost: "imap.zoho.com",
      imapPort: 993,
      imapSecurity: "tls",
      username: "rep@acme.io",
    });
    expect(parsed.password).toBe("app-password");
    expect(parsed.saveToSent).toBe(true);
  });

  test("587 means STARTTLS unless told otherwise", () => {
    expect(parseImapSmtpInput({ ...valid, smtpPort: 587 }, { requirePassword: true }).settings.smtpSecurity).toBe("starttls");
    expect(parseImapSmtpInput({ ...valid, smtpPort: 587, smtpSecurity: "tls" }, { requirePassword: true }).settings.smtpSecurity).toBe("tls");
  });

  test("refuses a URL, a host with a port, or a bad port", () => {
    expect(() => parseImapSmtpInput({ ...valid, smtpHost: "https://smtp.zoho.com" }, { requirePassword: true })).toThrow(ImapSmtpInputError);
    expect(() => parseImapSmtpInput({ ...valid, imapHost: "imap.zoho.com:993" }, { requirePassword: true })).toThrow(ImapSmtpInputError);
    expect(() => parseImapSmtpInput({ ...valid, smtpPort: 70000 }, { requirePassword: true })).toThrow(ImapSmtpInputError);
    expect(() => parseImapSmtpInput({ ...valid, imapPort: "abc" }, { requirePassword: true })).toThrow(ImapSmtpInputError);
  });

  test("refuses an unknown security mode — never plain text", () => {
    expect(() => parseImapSmtpInput({ ...valid, smtpSecurity: "none" }, { requirePassword: true })).toThrow(ImapSmtpInputError);
  });

  test("the password may be left out only when one is stored", () => {
    const { password, ...rest } = valid;
    void password;
    expect(() => parseImapSmtpInput(rest, { requirePassword: true })).toThrow("Password is required");
    expect(parseImapSmtpInput(rest, { requirePassword: false }).password).toBeNull();
  });

  test("saveToSent can be turned off", () => {
    expect(parseImapSmtpInput({ ...valid, saveToSent: false }, { requirePassword: true }).saveToSent).toBe(false);
  });

  test("every preset passes its own validation", () => {
    for (const preset of IMAP_SMTP_PRESETS) {
      expect(() => parseImapSmtpInput({ ...preset, username: "u@x.com", password: "p" }, { requirePassword: true })).not.toThrow();
    }
  });
});
