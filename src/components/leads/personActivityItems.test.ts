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

  test("a call reads its status, length and outcome; an AI call says so", () => {
    const [item] = personActivityItems([call({ mode: "agent_cloud", durationMs: 65_000, disposition: "no_answer" })], []);
    expect(item.title).toBe("AI agent call · Recorded");
    expect(item.detail).toBe("+15550100 · 1:05 · No answer");
    expect(personActivityItems([call({ status: "failed" })], [])[0].failed).toBe(true);
  });
});
