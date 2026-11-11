import { describe, expect, test } from "bun:test";
import { mailboxSendVerdict, ManualEmailError, normalizeManualEmail } from "./manualEmail";

describe("normalizeManualEmail", () => {
  test("trims the subject to one line and the body's line endings", () => {
    expect(normalizeManualEmail({ subject: "  Quick \n question ", body: "Hi,\r\n\r\nThanks  \n" })).toEqual({ subject: "Quick question", body: "Hi,\n\nThanks" });
  });

  test("refuses a missing subject or body, and anything not text", () => {
    for (const input of [{ subject: "", body: "x" }, { subject: "x", body: "  " }, { subject: 3, body: "x" }, {}]) {
      expect(() => normalizeManualEmail(input)).toThrow(ManualEmailError);
    }
  });

  test("refuses an over-long subject", () => {
    expect(() => normalizeManualEmail({ subject: "x".repeat(301), body: "x" })).toThrow(/too long/);
  });
});

describe("mailboxSendVerdict", () => {
  const now = new Date("2026-11-11T15:00:00.000Z");
  const mailbox = {
    emailAddress: "rep@example.test",
    status: "connected",
    dailySendLimit: 30,
    todayEmailsSent: 3,
    sendCounterResetAt: new Date("2026-11-11T08:00:00.000Z"),
    nextEmailTime: null as Date | null,
    workingHours: { timezone: "UTC" },
  };

  test("a connected mailbox under its limit and past its gap may send", () => {
    expect(mailboxSendVerdict(mailbox, now)).toEqual({ ok: true, countIsStale: false });
  });

  test("a mailbox that is not connected is a 409", () => {
    expect(mailboxSendVerdict({ ...mailbox, status: "error" }, now)).toMatchObject({ ok: false, status: 409 });
  });

  test("at the daily limit is a 429", () => {
    expect(mailboxSendVerdict({ ...mailbox, todayEmailsSent: 30 }, now)).toMatchObject({ ok: false, status: 429 });
  });

  test("a counter last reset yesterday counts as zero", () => {
    expect(mailboxSendVerdict({ ...mailbox, todayEmailsSent: 30, sendCounterResetAt: new Date("2026-11-10T08:00:00.000Z") }, now))
      .toEqual({ ok: true, countIsStale: true });
    expect(mailboxSendVerdict({ ...mailbox, sendCounterResetAt: null }, now)).toEqual({ ok: true, countIsStale: true });
  });

  test("inside the sending gap is a 429; once it has passed, it may send", () => {
    expect(mailboxSendVerdict({ ...mailbox, nextEmailTime: new Date(now.getTime() + 60_000) }, now)).toMatchObject({ ok: false, status: 429 });
    expect(mailboxSendVerdict({ ...mailbox, nextEmailTime: new Date(now.getTime() - 60_000) }, now)).toMatchObject({ ok: true });
  });
});
