import { describe, expect, test } from "bun:test";
import { MAX_POST_LENGTH, MISSED_TIME_ERROR } from "./contract";
import { parseSchedulePost } from "./requests";
import {
  missedTimeError,
  movedToNextDayNote,
  nearbyPosts,
  nextDayTime,
  nextOrganizationDayStart,
  planScheduledRun,
  scheduledPostVerdict,
  scheduledWaitReason,
  scheduleInputs,
  scheduleInstant,
  scheduleRefusal,
} from "./scheduleRules";

const at = (iso: string) => new Date(iso);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("scheduleInstant / scheduleInputs", () => {
  test("reads the date and time in the organization's zone, not the browser's", () => {
    expect(scheduleInstant("Asia/Kuala_Lumpur", "2026-11-13", "09:30")?.toISOString()).toBe("2026-11-13T01:30:00.000Z");
    expect(scheduleInstant("America/New_York", "2026-11-13", "09:30")?.toISOString()).toBe("2026-11-13T14:30:00.000Z");
    expect(scheduleInstant("UTC", "2026-11-13", "00:00")?.toISOString()).toBe("2026-11-13T00:00:00.000Z");
  });
  test("a date that does not exist, or a malformed one, is null", () => {
    expect(scheduleInstant("UTC", "2026-02-30", "09:00")).toBeNull();
    expect(scheduleInstant("UTC", "2026-13-01", "09:00")).toBeNull();
    expect(scheduleInstant("UTC", "13/11/2026", "09:00")).toBeNull();
    expect(scheduleInstant("UTC", "2026-11-13", "24:00")).toBeNull();
    expect(scheduleInstant("UTC", "2026-11-13", "9:00")).toBeNull();
  });
  test("a time skipped by DST moves forward by the gap", () => {
    expect(scheduleInstant("America/New_York", "2026-03-08", "02:30")?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
  test("round trip through the inputs", () => {
    const instant = at("2026-11-13T01:30:00Z");
    expect(scheduleInputs("Asia/Kuala_Lumpur", instant)).toEqual({ date: "2026-11-13", time: "09:30" });
    expect(scheduleInputs("America/Los_Angeles", instant)).toEqual({ date: "2026-11-12", time: "17:30" });
    const { date, time } = scheduleInputs("Europe/London", instant);
    expect(scheduleInstant("Europe/London", date, time)?.toISOString()).toBe(instant.toISOString());
  });
});

describe("scheduleRefusal", () => {
  const now = at("2026-11-12T10:00:00Z");
  const base = { status: "draft" as const, body: "Hello", scheduledAt: new Date(now.getTime() + 10 * MIN), now };
  test("a draft or a scheduled post with text, at least 5 minutes ahead, may be scheduled", () => {
    expect(scheduleRefusal(base)).toBeNull();
    expect(scheduleRefusal({ ...base, status: "scheduled" })).toBeNull();
    expect(scheduleRefusal({ ...base, scheduledAt: new Date(now.getTime() + 5 * MIN) })).toBeNull();
  });
  test("less than 5 minutes ahead, or in the past, is refused", () => {
    expect(scheduleRefusal({ ...base, scheduledAt: new Date(now.getTime() + 4 * MIN) })).toMatchObject({ status: 400 });
    expect(scheduleRefusal({ ...base, scheduledAt: new Date(now.getTime() - HOUR) })).toMatchObject({ status: 400 });
  });
  test("more than a year ahead is refused", () => {
    expect(scheduleRefusal({ ...base, scheduledAt: new Date(now.getTime() + 400 * 24 * HOUR) })).toMatchObject({ status: 400 });
  });
  test("text is required and within the limit", () => {
    expect(scheduleRefusal({ ...base, body: " \n" })).toMatchObject({ status: 400 });
    expect(scheduleRefusal({ ...base, body: "x".repeat(MAX_POST_LENGTH + 1) })).toMatchObject({ status: 400 });
  });
  test("published, publishing and failed posts cannot be scheduled", () => {
    for (const status of ["published", "publishing", "failed"] as const) expect(scheduleRefusal({ ...base, status })).toMatchObject({ status: 409 });
  });
});

describe("scheduledPostVerdict", () => {
  const scheduledAt = at("2026-11-12T10:00:00Z");
  test("not due, due, then late after 6 hours", () => {
    expect(scheduledPostVerdict(scheduledAt, at("2026-11-12T09:59:59Z"))).toBe("not-due");
    expect(scheduledPostVerdict(scheduledAt, scheduledAt)).toBe("due");
    expect(scheduledPostVerdict(scheduledAt, at("2026-11-12T16:00:00Z"))).toBe("due");
    expect(scheduledPostVerdict(scheduledAt, at("2026-11-12T16:00:01Z"))).toBe("late");
  });
});

describe("planScheduledRun", () => {
  const now = at("2026-11-12T12:00:00Z");
  const post = (id: string, account: string, iso: string, organizationId = "org-a") => ({ id, organizationId, linkedinAccountId: account, scheduledAt: at(iso) });

  test("one post per account per run, the oldest", () => {
    const plan = planScheduledRun(
      [post("b", "acc1", "2026-11-12T11:59:00Z"), post("a", "acc1", "2026-11-12T11:59:00Z"), post("c", "acc1", "2026-11-12T11:00:00Z"), post("d", "acc2", "2026-11-12T11:30:00Z")],
      now,
    );
    expect(plan.publish.map((p) => p.id)).toEqual(["c", "d"]);
    expect(plan.later.map((p) => p.id)).toEqual(["a", "b"]);
    expect(plan.late).toEqual([]);
  });
  test("two posts for the same minute: one now, the other next run", () => {
    const plan = planScheduledRun([post("x", "acc1", "2026-11-12T11:58:00Z"), post("y", "acc1", "2026-11-12T11:58:00Z")], now);
    expect(plan.publish.map((p) => p.id)).toEqual(["x"]);
    expect(plan.later.map((p) => p.id)).toEqual(["y"]);
  });
  test("more than 6 hours late fails, and does not take the account's turn", () => {
    const plan = planScheduledRun([post("old", "acc1", "2026-11-12T05:59:00Z"), post("ok", "acc1", "2026-11-12T06:30:00Z")], now);
    expect(plan.late.map((p) => p.id)).toEqual(["old"]);
    expect(plan.publish.map((p) => p.id)).toEqual(["ok"]);
  });
  test("posts not yet due are ignored", () => {
    const plan = planScheduledRun([post("future", "acc1", "2026-11-12T12:01:00Z")], now);
    expect(plan).toEqual({ late: [], publish: [], later: [] });
  });
  test("accounts are separate across organizations too", () => {
    const plan = planScheduledRun([post("a", "acc1", "2026-11-12T11:00:00Z"), post("b", "acc2", "2026-11-12T11:00:00Z", "org-b")], now);
    expect(plan.publish.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("the next day", () => {
  test("the organization's next day start, with a day starting mid-morning", () => {
    expect(nextOrganizationDayStart("UTC", "00:00", at("2026-11-12T23:59:00Z")).toISOString()).toBe("2026-11-13T00:00:00.000Z");
    expect(nextOrganizationDayStart("UTC", "06:00", at("2026-11-12T05:00:00Z")).toISOString()).toBe("2026-11-12T06:00:00.000Z");
    expect(nextOrganizationDayStart("Asia/Kuala_Lumpur", "00:00", at("2026-11-12T10:00:00Z")).toISOString()).toBe("2026-11-12T16:00:00.000Z");
  });
  test("a held-back post moves to the same time tomorrow", () => {
    const next = nextOrganizationDayStart("Asia/Kuala_Lumpur", "00:00", at("2026-11-12T02:05:00Z"));
    expect(nextDayTime("Asia/Kuala_Lumpur", at("2026-11-12T02:00:00Z"), next).toISOString()).toBe("2026-11-13T02:00:00.000Z");
  });
  test("keeps the wall-clock time across a DST change", () => {
    const next = nextOrganizationDayStart("America/New_York", "00:00", at("2026-11-01T02:00:00Z"));
    // 22:00 EDT on Oct 31 → 22:00 EST on Nov 1 (25 hours later).
    expect(nextDayTime("America/New_York", at("2026-11-01T02:00:00Z"), next).toISOString()).toBe("2026-11-02T03:00:00.000Z");
  });
  test("a post from before today's start still lands after it", () => {
    // Day starts 06:00; the post was for 05:00 and is seen at 05:10: "tomorrow" is the day starting 06:00 today.
    const next = nextOrganizationDayStart("UTC", "06:00", at("2026-11-12T05:10:00Z"));
    expect(nextDayTime("UTC", at("2026-11-12T05:00:00Z"), next).toISOString()).toBe("2026-11-13T05:00:00.000Z");
  });
});

describe("scheduledWaitReason", () => {
  const base = {
    unipileConnected: true,
    account: { status: "CONNECTED" as const, name: "Ada" },
    scheduledAt: at("2026-11-12T15:00:00Z"),
    publishedToday: 0,
    postsPerDay: 2,
    nextDayStart: at("2026-11-13T00:00:00Z"),
  };
  test("nothing in the way", () => {
    expect(scheduledWaitReason(base)).toBeNull();
    expect(scheduledWaitReason({ ...base, publishedToday: 1 })).toBeNull();
  });
  test("Unipile, the account, the daily limit", () => {
    expect(scheduledWaitReason({ ...base, unipileConnected: false })).toContain("Unipile is not connected");
    expect(scheduledWaitReason({ ...base, account: null })).toContain("no longer in your organization");
    expect(scheduledWaitReason({ ...base, account: { status: "DISCONNECTED", name: "Ada" } })).toContain("Ada's LinkedIn account is disconnected");
    expect(scheduledWaitReason({ ...base, publishedToday: 2 })).toContain("will move to the same time tomorrow");
  });
  test("today's limit does not hold back a post for another day", () => {
    expect(scheduledWaitReason({ ...base, publishedToday: 2, scheduledAt: at("2026-11-13T09:00:00Z") })).toBeNull();
  });
});

describe("messages", () => {
  test("missed its time", () => {
    expect(missedTimeError()).toStartWith(MISSED_TIME_ERROR);
    expect(missedTimeError("Ada's account is disconnected.")).toContain("Ada's account is disconnected.");
  });
  test("moved to the next day", () => {
    expect(movedToNextDayNote("Ada", 1)).toContain("1 post that day");
    expect(movedToNextDayNote("Ada", 3)).toContain("3 posts that day");
  });
});

describe("nearbyPosts", () => {
  const others = [
    { id: "p1", at: "2026-11-12T10:00:00Z", status: "scheduled" as const },
    { id: "p2", at: "2026-11-12T13:59:00Z", status: "published" as const },
    { id: "p3", at: "2026-11-12T18:00:00Z", status: "scheduled" as const },
  ];
  test("within 4 hours either side, the post itself left out", () => {
    expect(nearbyPosts(at("2026-11-12T13:00:00Z"), others, null).map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(nearbyPosts(at("2026-11-12T14:00:00Z"), others, null).map((p) => p.id)).toEqual(["p2"]);
    expect(nearbyPosts(at("2026-11-12T10:00:00Z"), others, "p1").map((p) => p.id)).toEqual(["p2"]);
    expect(nearbyPosts(at("2026-11-13T10:00:00Z"), others, null)).toEqual([]);
  });
});

describe("parseSchedulePost", () => {
  test("a date and a time", () => {
    expect(parseSchedulePost({ date: "2026-11-13", time: "09:30" })).toEqual({ ok: true, value: { date: "2026-11-13", time: "09:30" } });
  });
  test("anything else is refused", () => {
    expect(parseSchedulePost(null).ok).toBe(false);
    expect(parseSchedulePost([]).ok).toBe(false);
    expect(parseSchedulePost({ time: "09:30" }).ok).toBe(false);
    expect(parseSchedulePost({ date: "2026-11-13" }).ok).toBe(false);
    expect(parseSchedulePost({ date: "2026-11-13", time: "9:30" }).ok).toBe(false);
    expect(parseSchedulePost({ date: "2026-11-13T09:30:00Z", time: "09:30" }).ok).toBe(false);
    expect(parseSchedulePost({ date: "2026-11-13", time: "24:00" }).ok).toBe(false);
    expect(parseSchedulePost({ date: 20261113, time: "09:30" }).ok).toBe(false);
  });
});
