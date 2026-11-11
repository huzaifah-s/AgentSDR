import { describe, expect, test } from "bun:test";
import { internalSchedulerEnabled } from "./config";
import { PLATFORM_JOBS, platformJob } from "./schedules";
import { dailyAt, everyMinutes, latestDailySlot, latestDueSlot, wallTimeToInstant } from "./slots";

const at = (iso: string) => new Date(iso);
const slot = (schedule: Parameters<typeof latestDueSlot>[0], now: string) => latestDueSlot(schedule, at(now)).toISOString();

describe("every N minutes", () => {
  const every30 = everyMinutes(30);
  const every10 = everyMinutes(10);

  test("aligned to the UTC clock", () => {
    expect(slot(every30, "2026-10-08T10:00:00.000Z")).toBe("2026-10-08T10:00:00.000Z");
    expect(slot(every30, "2026-10-08T10:29:59.999Z")).toBe("2026-10-08T10:00:00.000Z");
    expect(slot(every30, "2026-10-08T10:30:00.000Z")).toBe("2026-10-08T10:30:00.000Z");
    expect(slot(every10, "2026-10-08T23:59:59.000Z")).toBe("2026-10-08T23:50:00.000Z");
  });

  test("a call a few minutes late lands on the same slot", () => {
    const onTime = slot(every30, "2026-10-08T10:30:01Z");
    expect(slot(every30, "2026-10-08T10:33:40Z")).toBe(onTime);
    expect(slot(every10, "2026-10-08T10:39:59Z")).toBe(slot(every10, "2026-10-08T10:30:00Z"));
  });

  test("after downtime only the latest slot is due", () => {
    expect(slot(every30, "2026-10-08T17:45:00Z")).toBe("2026-10-08T17:30:00.000Z");
  });

  test("refuses intervals that do not divide the hour or day", () => {
    expect(() => everyMinutes(7)).toThrow();
    expect(() => everyMinutes(0)).toThrow();
    expect(() => everyMinutes(90)).toThrow();
    expect(everyMinutes(120)).toEqual({ kind: "interval", minutes: 120 });
  });
});

describe("daily", () => {
  test("UTC: today's slot once due, yesterday's before", () => {
    const midnight = dailyAt("00:00");
    expect(slot(midnight, "2026-10-08T00:00:00Z")).toBe("2026-10-08T00:00:00.000Z");
    expect(slot(midnight, "2026-10-08T23:59:59Z")).toBe("2026-10-08T00:00:00.000Z");
    const five = dailyAt("05:00");
    expect(slot(five, "2026-10-08T04:59:59Z")).toBe("2026-10-07T05:00:00.000Z");
    expect(slot(five, "2026-10-08T05:00:00Z")).toBe("2026-10-08T05:00:00.000Z");
    expect(slot(five, "2026-10-08T05:07:00Z")).toBe("2026-10-08T05:00:00.000Z"); // late, same slot
  });

  test("month and year boundaries", () => {
    expect(latestDailySlot("UTC", "23:30", at("2027-01-01T00:10:00Z")).toISOString()).toBe("2026-12-31T23:30:00.000Z");
    expect(latestDailySlot("UTC", "00:00", at("2028-03-01T00:00:00Z")).toISOString()).toBe("2028-03-01T00:00:00.000Z");
  });

  test("half-hour zone: Asia/Kolkata (UTC+5:30, no DST)", () => {
    // Local midnight is 18:30 UTC the day before.
    expect(latestDailySlot("Asia/Kolkata", "00:00", at("2026-10-08T10:00:00Z")).toISOString()).toBe("2026-10-07T18:30:00.000Z");
    expect(latestDailySlot("Asia/Kolkata", "00:00", at("2026-10-08T18:29:59Z")).toISOString()).toBe("2026-10-07T18:30:00.000Z");
    expect(latestDailySlot("Asia/Kolkata", "00:00", at("2026-10-08T18:30:00Z")).toISOString()).toBe("2026-10-08T18:30:00.000Z");
    expect(latestDailySlot("Asia/Kolkata", "10:30", at("2026-10-08T05:00:00Z")).toISOString()).toBe("2026-10-08T05:00:00.000Z");
  });

  test("America/New_York across spring forward (2026-03-08, 02:00 -> 03:00)", () => {
    // Midnight before the change is EST (-5), the next midnight EDT (-4).
    expect(latestDailySlot("America/New_York", "00:00", at("2026-03-08T12:00:00Z")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(latestDailySlot("America/New_York", "00:00", at("2026-03-09T12:00:00Z")).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    // 02:30 does not exist that day: it moves forward by the gap, to 03:30 EDT (07:30Z).
    expect(wallTimeToInstant("America/New_York", 2026, 3, 8, 2, 30)).toBe(Date.parse("2026-03-08T07:30:00Z"));
    expect(latestDailySlot("America/New_York", "02:30", at("2026-03-08T07:29:00Z")).toISOString()).toBe("2026-03-07T07:30:00.000Z");
    expect(latestDailySlot("America/New_York", "02:30", at("2026-03-08T07:30:00Z")).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  test("America/New_York across fall back (2026-11-01, 02:00 -> 01:00)", () => {
    // 01:30 happens twice; the first (EDT, 05:30Z) is the slot, and the second does not start another day.
    expect(wallTimeToInstant("America/New_York", 2026, 11, 1, 1, 30)).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(latestDailySlot("America/New_York", "01:30", at("2026-11-01T06:45:00Z")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    // Midnight after the change is EST.
    expect(latestDailySlot("America/New_York", "00:00", at("2026-11-02T06:00:00Z")).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  test("each local day has exactly one slot across a DST change", () => {
    const seen = new Set<string>();
    for (let t = Date.parse("2026-03-06T00:00:00Z"); t < Date.parse("2026-03-11T00:00:00Z"); t += 15 * 60_000) {
      seen.add(latestDailySlot("America/New_York", "00:00", new Date(t)).toISOString());
    }
    expect([...seen]).toEqual([
      "2026-03-05T05:00:00.000Z",
      "2026-03-06T05:00:00.000Z",
      "2026-03-07T05:00:00.000Z",
      "2026-03-08T05:00:00.000Z",
      "2026-03-09T04:00:00.000Z",
      "2026-03-10T04:00:00.000Z",
    ]);
  });

  test("Europe/Berlin gap and a positive-offset zone", () => {
    expect(wallTimeToInstant("Europe/Berlin", 2026, 3, 29, 2, 30)).toBe(Date.parse("2026-03-29T01:30:00Z")); // 03:30 CEST
    expect(latestDailySlot("Europe/Berlin", "00:00", at("2026-03-29T12:00:00Z")).toISOString()).toBe("2026-03-28T23:00:00.000Z");
  });

  test("refuses a malformed time", () => {
    expect(() => dailyAt("24:00")).toThrow();
    expect(() => latestDailySlot("UTC", "7:00", new Date())).toThrow();
  });
});

describe("registry", () => {
  test("in-process jobs and their schedules", () => {
    expect(PLATFORM_JOBS.filter((j) => j.enabled).map((j) => j.name)).toEqual(["linkedin-run-outreach", "linkedin-replay-webhooks", "linkedin-publish-posts", "crm-auto-follow-ups", "email-imap-sync", "history-prune"]);
    expect(platformJob("linkedin-publish-posts").schedule).toEqual({ kind: "interval", minutes: 2 });
    expect(platformJob("linkedin-publish-posts").endpoint).toBe("/api/linkedin/jobs/publish-posts");
    expect(platformJob("linkedin-run-outreach").schedule).toEqual({ kind: "interval", minutes: 30 });
    expect(platformJob("linkedin-replay-webhooks").schedule).toEqual({ kind: "interval", minutes: 10 });
    expect(platformJob("linkedin-run-search-queue").enabled).toBe(false);
    expect(platformJob("history-prune").schedule).toEqual({ kind: "daily", at: "00:00", timeZone: "UTC" });
  });
});

describe("internalSchedulerEnabled", () => {
  test("production only, not in the demo, off with INTERNAL_SCHEDULER=false", () => {
    expect(internalSchedulerEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(internalSchedulerEnabled({ NODE_ENV: "production", INTERNAL_SCHEDULER: "true" })).toBe(true);
    expect(internalSchedulerEnabled({ NODE_ENV: "production", INTERNAL_SCHEDULER: "false" })).toBe(false);
    expect(internalSchedulerEnabled({ NODE_ENV: "production", INTERNAL_SCHEDULER: " OFF " })).toBe(false);
    expect(internalSchedulerEnabled({ NODE_ENV: "production", DEMO_MODE: "true" })).toBe(false);
    expect(internalSchedulerEnabled({ NODE_ENV: "development" })).toBe(false);
  });
});
