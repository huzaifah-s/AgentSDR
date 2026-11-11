import { describe, expect, test } from "bun:test";
import type { CallSummary } from "@/lib/calls/contract";
import type { PersonActivityEvent } from "@/lib/leads/personActivity";
import { personActivityItems } from "./personActivityItems";

const call = (overrides: Partial<CallSummary>): CallSummary => ({
  id: "c1", personId: "p1", crmRecordId: null, campaignContactId: null, phone: "+15550100", status: "recorded",
  startedAt: null, endedAt: null, durationMs: null, hasRecording: false, recordingOffsetMs: null, error: null,
  disposition: null, transcriptStatus: "none", createdAt: "2026-11-01T10:00:00.000Z", ...overrides,
});
const event = (overrides: Partial<PersonActivityEvent>): PersonActivityEvent => ({
  id: "e1", eventType: "record.created", actorType: "system", actorRef: null, crmRecordId: null, meta: null,
  createdAt: "2026-11-02T10:00:00.000Z", ...overrides,
});

describe("personActivityItems", () => {
  test("merges calls and events, newest first", () => {
    const items = personActivityItems(
      [call({ id: "old", createdAt: "2026-11-01T10:00:00.000Z" }), call({ id: "new", startedAt: "2026-11-03T10:00:00.000Z" })],
      [event({ id: "mid" })],
    );
    expect(items.map((item) => item.id)).toEqual(["call:new", "event:mid", "call:old"]);
  });

  test("an event dates from meta.occurredAt when it has one, and shows meta.summary", () => {
    const [item] = personActivityItems([], [event({ eventType: "some.thing", meta: { occurredAt: "2026-10-01T09:00:00.000Z", summary: " Met at the event " } })]);
    expect(item.at).toBe("2026-10-01T09:00:00.000Z");
    expect(item.title).toBe("Some thing");
    expect(item.detail).toBe("Met at the event");
  });

  test("a logged update reads its kind, direction, summary and follow-up", () => {
    const [item] = personActivityItems([], [event({
      eventType: "activity.logged",
      meta: { kind: "whatsapp", direction: "inbound", summary: "Interested", occurredAt: "2026-11-01T09:00:00.000Z", followUpAt: "2026-11-13T10:00:00.000Z" },
    })]);
    expect(item.title).toBe("WhatsApp (my phone) · They replied");
    expect(item.detail).toStartWith("Interested\nNext follow-up: Nov 13, 2026");
    expect(item.at).toBe("2026-11-01T09:00:00.000Z");
  });

  test("an email sent from Leads shows once: its CRM audit copy is left out", () => {
    const items = personActivityItems([], [
      event({ id: "sent", eventType: "manual_email.sent", meta: { subject: "Hello", from: "rep@example.test" } }),
      event({ id: "echo", eventType: "message.recorded", meta: { source: "leads" } }),
      event({ id: "phone", eventType: "message.recorded", meta: { origin: "phone" } }),
    ]);
    expect(items.map((item) => item.id)).toEqual(["event:sent", "event:phone"]);
    expect(items[0].detail).toBe("“Hello” from rep@example.test");
  });

  test("a call reads its status, length and outcome; an AI call says so", () => {
    const [item] = personActivityItems([call({ mode: "agent_cloud", durationMs: 65_000, disposition: "no_answer" })], []);
    expect(item.title).toBe("AI agent call · Recorded");
    expect(item.detail).toBe("+15550100 · 1:05 · No answer");
    expect(personActivityItems([call({ status: "failed" })], [])[0].failed).toBe(true);
  });
});
