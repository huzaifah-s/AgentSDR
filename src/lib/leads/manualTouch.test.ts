import { describe, expect, test } from "bun:test";
import { manualFollowUpDecision, ManualTouchError, normalizeLoggedUpdate, type ManualFollowUpState } from "./manualTouch";

const now = new Date("2026-11-11T12:00:00.000Z");

describe("normalizeLoggedUpdate", () => {
  test("defaults to now and outbound, and trims the summary", () => {
    expect(normalizeLoggedUpdate({ kind: "call", summary: "  No answer \r\n" }, now)).toEqual({
      kind: "call", direction: "outbound", occurredAt: now, summary: "No answer", followUpAt: null,
    });
  });

  test("keeps a past time, an inbound direction and a future follow-up", () => {
    const update = normalizeLoggedUpdate({
      kind: "whatsapp", direction: "inbound", summary: "Interested, call Thursday",
      occurredAt: "2026-11-10T09:00:00.000Z", followUpAt: "2026-11-13T10:00:00.000Z",
    }, now);
    expect(update.direction).toBe("inbound");
    expect(update.occurredAt.toISOString()).toBe("2026-11-10T09:00:00.000Z");
    expect(update.followUpAt?.toISOString()).toBe("2026-11-13T10:00:00.000Z");
  });

  test("refuses an unknown kind, an empty summary, a future update and a past follow-up", () => {
    const bad = [
      { kind: "fax", summary: "x" },
      { kind: "note", summary: "   " },
      { kind: "note", summary: "x", direction: "sideways" },
      { kind: "note", summary: "x", occurredAt: "2026-11-12T12:00:00.000Z" },
      { kind: "note", summary: "x", occurredAt: "not a date" },
      { kind: "note", summary: "x", followUpAt: "2026-11-11T11:00:00.000Z" },
    ];
    for (const input of bad) expect(() => normalizeLoggedUpdate(input, now)).toThrow(ManualTouchError);
  });

  test("allows a few minutes of clock skew", () => {
    expect(() => normalizeLoggedUpdate({ kind: "note", summary: "x", occurredAt: "2026-11-11T12:03:00.000Z" }, now)).not.toThrow();
  });
});

describe("manualFollowUpDecision", () => {
  const due = new Date("2026-11-13T10:00:00.000Z");
  const record: ManualFollowUpState = { workflowState: "idle", nextActionAt: null, activeChannel: null, latestInboundMessageId: null };

  test("an idle record with no reply waits for the date, on the update's channel", () => {
    expect(manualFollowUpDecision(record, due, "email")).toEqual({ apply: true, update: { workflowState: "waiting", nextActionAt: due, activeChannel: "email" } });
    expect(manualFollowUpDecision(record, due, "call")).toMatchObject({ apply: true, update: { activeChannel: "whatsapp" } });
    expect(manualFollowUpDecision(record, due, "meeting")).toMatchObject({ apply: true, update: { activeChannel: null } });
  });

  test("a record's own channel is kept", () => {
    expect(manualFollowUpDecision({ ...record, workflowState: "waiting", activeChannel: "whatsapp" }, due, "email"))
      .toMatchObject({ apply: true, update: { activeChannel: "whatsapp" } });
  });

  test("a record with a reply in the CRM, or one that needs a person, is left alone", () => {
    expect(manualFollowUpDecision({ ...record, latestInboundMessageId: "m1" }, due, "call")).toMatchObject({ apply: false });
    for (const workflowState of ["action_required", "paused", "closed", "error", "classifying"] as const) {
      expect(manualFollowUpDecision({ ...record, workflowState }, due, "call")).toMatchObject({ apply: false });
    }
  });
});
