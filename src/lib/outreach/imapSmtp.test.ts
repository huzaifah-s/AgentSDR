import { describe, expect, test } from "bun:test";

import { buildRawEmailMessage } from "./gmail";
import { MailServerAddressError, parseImapMessage, resolveMailHost } from "./imapSmtp";

describe("resolveMailHost", () => {
  test("connects to the checked public address, keeping the name for TLS", async () => {
    expect(await resolveMailHost("smtp.example.com", async () => ["93.184.215.14"], false)).toEqual({
      address: "93.184.215.14",
      servername: "smtp.example.com",
    });
  });

  test("refuses a host that resolves to a private, loopback or metadata address", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "100.64.1.1", "::1"]) {
      await expect(resolveMailHost("mail.example.com", async () => [address], false)).rejects.toBeInstanceOf(MailServerAddressError);
    }
    await expect(resolveMailHost("127.0.0.1", async () => [], false)).rejects.toBeInstanceOf(MailServerAddressError);
  });

  test("refuses when any one of the addresses is private", async () => {
    await expect(resolveMailHost("mail.example.com", async () => ["93.184.215.14", "192.168.1.2"], false)).rejects.toBeInstanceOf(MailServerAddressError);
  });

  test("a host that does not resolve is a clear error", async () => {
    await expect(resolveMailHost("nope.invalid", async () => { throw new Error("ENOTFOUND"); }, false)).rejects.toThrow("Could not find the server");
  });

  test("self-hosters may allow private addresses", async () => {
    expect(await resolveMailHost("mail.lan", async () => ["10.0.0.5"], true)).toEqual({ address: "mail.lan", servername: undefined });
  });
});

describe("SMTP raw message", () => {
  test("carries our Message-ID and leaves Bcc for the envelope", async () => {
    const raw = (await buildRawEmailMessage(
      { from: "rep@acme.io", to: ["lead@prospect.com"], bcc: ["boss@acme.io"], subject: "Hi", text: "Body" },
      { keepBcc: false, messageId: "<fixed@acme.io>" },
    )).toString();
    const headers = raw.split(/\r?\n\r?\n/, 1)[0];
    expect(headers).toMatch(/^Message-ID: <fixed@acme\.io>$/mi);
    expect(headers).not.toMatch(/^Bcc:/mi);
  });
});

describe("parseImapMessage", () => {
  const reply = [
    "From: Lead Person <Lead@Prospect.com>",
    "To: Rep <rep@acme.io>",
    "Cc: other@prospect.com",
    "Subject: Re: Quick question",
    "Message-ID: <reply-1@prospect.com>",
    "In-Reply-To: <m2@acme.io>",
    "References: <m1@acme.io> <m2@acme.io>",
    "Date: Tue, 10 Nov 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Sounds good, let's talk Thursday.",
    "",
  ].join("\r\n");

  test("reads a reply into the bridge's shape, threaded by its root", async () => {
    const { message, references } = await parseImapMessage(Buffer.from(reply), 42, "777");
    expect(message.source).toBe("imap");
    expect(message.gmailMessageId).toBe("<reply-1@prospect.com>");
    expect(message.messageId).toBe("<reply-1@prospect.com>");
    expect(message.threadId).toBe("<m1@acme.io>");
    expect(message.inReplyTo).toBe("<m2@acme.io>");
    expect(message.fromEmail).toBe("lead@prospect.com");
    expect(message.fromName).toBe("Lead Person");
    expect(message.toEmail).toBe("rep@acme.io");
    expect(message.ccEmails).toEqual(["other@prospect.com"]);
    expect(message.subject).toBe("Re: Quick question");
    expect(message.bodyText?.trim()).toBe("Sounds good, let's talk Thursday.");
    expect(message.internalDate?.toISOString()).toBe("2026-11-10T10:00:00.000Z");
    expect(references).toEqual(["<m1@acme.io>", "<m2@acme.io>"]);
  });

  test("a message without a Message-ID is keyed by its UID", async () => {
    const { message } = await parseImapMessage(Buffer.from("From: a@b.com\r\nSubject: x\r\n\r\nhi\r\n"), 9, "555");
    expect(message.gmailMessageId).toBe("uid:555:9");
    expect(message.threadId).toBeNull();
  });

  test("a bounce keeps its machine-readable recipient for the bounce parser", async () => {
    const bounce = [
      "From: Mail Delivery System <MAILER-DAEMON@mx.acme.io>",
      "To: rep@acme.io",
      "Subject: Undelivered Mail Returned to Sender",
      "Message-ID: <bounce-1@mx.acme.io>",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "I'm sorry to have to inform you that your message could not be delivered.",
      "--b",
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; mx.acme.io",
      "",
      "Final-Recipient: rfc822; gone@prospect.com",
      "Action: failed",
      "Status: 5.1.1",
      "--b--",
      "",
    ].join("\r\n");
    const { message } = await parseImapMessage(Buffer.from(bounce), 1, "1");
    expect(message.fromEmail).toBe("mailer-daemon@mx.acme.io");
    expect(message.bodyText).toContain("Final-Recipient: rfc822; gone@prospect.com");
  });
});

describe("mailServerErrorMessage", () => {
  test("names an unreachable server even when the error has no message", async () => {
    const { mailServerErrorMessage } = await import("./imapSmtp");
    const imapRefused = Object.assign(new Error(""), { code: "ECONNREFUSED" });
    expect(mailServerErrorMessage(imapRefused)).toBe("Could not reach the server (ECONNREFUSED) — check the host, port and security");
    const smtpRefused = Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:465"), { code: "ESOCKET" });
    expect(mailServerErrorMessage(smtpRefused)).toContain("Could not reach the server (connect ECONNREFUSED");
  });
  test("a refused login points at app passwords", async () => {
    const { mailServerErrorMessage } = await import("./imapSmtp");
    expect(mailServerErrorMessage(Object.assign(new Error("x"), { authenticationFailed: true }))).toContain("app password");
    expect(mailServerErrorMessage(Object.assign(new Error("Invalid login"), { code: "EAUTH", response: "535 5.7.8 Authentication failed" }))).toBe(
      "The server refused the username or password: 535 5.7.8 Authentication failed",
    );
  });
});
