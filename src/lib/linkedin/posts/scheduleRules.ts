/**
 * Scheduling's decisions (Phase 3), pure so they are tested without a
 * database, a clock or Unipile: when a post may be scheduled, which due posts
 * one run of the job publishes, fails or leaves, where a post over the daily
 * limit moves to, and why a scheduled post is waiting. Client-safe: the
 * composer uses the time-zone and "nearby post" helpers too.
 */
import { latestDailySlot, wallTime, wallTimeToInstant } from "@/lib/scheduler/slots";
import {
  MAX_POST_LENGTH,
  MAX_SCHEDULE_AHEAD_MS,
  MAX_SCHEDULE_LATENESS_MS,
  MIN_SCHEDULE_LEAD_MS,
  MISSED_TIME_ERROR,
  NEARBY_POST_WARNING_MS,
  type LinkedinPostStatus,
  type PostTime,
} from "./contract";
import type { PublishRefusal } from "./publishRules";

/** Statuses a post may be scheduled from. A failed post is saved (back to a draft) first. */
export const SCHEDULABLE_STATUSES: readonly LinkedinPostStatus[] = ["draft", "scheduled"];

// ------------------------------------------------------------ time zone

/**
 * The instant of a date ("YYYY-MM-DD") and time ("HH:MM") read in the
 * organization's time zone. Null when the date does not exist (Feb 30).
 * A time skipped by a DST change moves forward by the gap (slots.ts).
 */
export function scheduleInstant(timeZone: string, date: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!d || !t) return null;
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return new Date(wallTimeToInstant(timeZone, year, month, day, Number(t[1]), Number(t[2])));
}

/** An instant as the composer's date and time inputs show it, in the organization's time zone. */
export function scheduleInputs(timeZone: string, instant: Date): { date: string; time: string } {
  const w = wallTime(timeZone, instant.getTime());
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return { date: `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`, time: `${pad(w.hour)}:${pad(w.minute)}` };
}

/** When the organization's next day begins (Settings → Organization: time zone, new day starts at). */
export function nextOrganizationDayStart(timeZone: string, dayStartsAt: string, now: Date): Date {
  const today = latestDailySlot(timeZone, dayStartsAt, now);
  // A day is 23 to 25 hours long, so 36 h after today's start is always inside the next day.
  return latestDailySlot(timeZone, dayStartsAt, new Date(today.getTime() + 36 * 60 * 60 * 1000));
}

/**
 * Where a post the daily limit held back moves to: the same wall-clock time
 * on the first day that is not today (in the organization's day), so it
 * goes out tomorrow at the hour the person chose.
 */
export function nextDayTime(timeZone: string, scheduledAt: Date, nextDayStart: Date): Date {
  const w = wallTime(timeZone, scheduledAt.getTime());
  for (let days = 1; days <= 3; days++) {
    const date = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
    const at = wallTimeToInstant(timeZone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), w.hour, w.minute);
    if (at >= nextDayStart.getTime()) return new Date(at);
  }
  return nextDayStart;
}

// ------------------------------------------------------------ scheduling

/** Whether a post may be scheduled for `scheduledAt`. Null means yes. */
export function scheduleRefusal(input: { status: LinkedinPostStatus; body: string; scheduledAt: Date; now: Date }): PublishRefusal | null {
  if (!SCHEDULABLE_STATUSES.includes(input.status)) {
    if (input.status === "published") return { status: 409, message: "This post is already published." };
    if (input.status === "publishing") return { status: 409, message: "This post is being published." };
    return { status: 409, message: "Save this post as a draft before scheduling it." };
  }
  if (!input.body.trim()) return { status: 400, message: "Write something before scheduling." };
  if (input.body.length > MAX_POST_LENGTH) {
    return { status: 400, message: `A post can be at most ${MAX_POST_LENGTH.toLocaleString("en-US")} characters.` };
  }
  const ahead = input.scheduledAt.getTime() - input.now.getTime();
  if (ahead < MIN_SCHEDULE_LEAD_MS) return { status: 400, message: "Choose a time at least 5 minutes from now." };
  if (ahead > MAX_SCHEDULE_AHEAD_MS) return { status: 400, message: "Choose a time within the next year." };
  return null;
}

/** A scheduled post's state at `now`. */
export function scheduledPostVerdict(scheduledAt: Date, now: Date): "not-due" | "due" | "late" {
  const late = now.getTime() - scheduledAt.getTime();
  if (late < 0) return "not-due";
  return late > MAX_SCHEDULE_LATENESS_MS ? "late" : "due";
}

export type DuePost = { id: string; organizationId: string; linkedinAccountId: string; scheduledAt: Date };

/**
 * What one run of the job does with the due posts it found:
 *
 * - `late`: more than 6 hours past their time. They fail instead of going
 *   out late.
 * - `publish`: the oldest due post of each account, at most one per account,
 *   so two posts scheduled for the same minute do not land together.
 * - `later`: the rest, left for the next runs.
 *
 * Oldest first throughout (ties by id, so the order is stable).
 */
export function planScheduledRun<T extends DuePost>(posts: readonly T[], now: Date): { late: T[]; publish: T[]; later: T[] } {
  const ordered = [...posts]
    .filter((post) => scheduledPostVerdict(post.scheduledAt, now) !== "not-due")
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || a.id.localeCompare(b.id));
  const late: T[] = [];
  const publish: T[] = [];
  const later: T[] = [];
  const accounts = new Set<string>();
  for (const post of ordered) {
    if (scheduledPostVerdict(post.scheduledAt, now) === "late") late.push(post);
    else if (accounts.has(post.linkedinAccountId)) later.push(post);
    else {
      accounts.add(post.linkedinAccountId);
      publish.push(post);
    }
  }
  return { late, publish, later };
}

/** The error a post too late to go out is failed with. */
export function missedTimeError(reason?: string | null): string {
  const base = `${MISSED_TIME_ERROR} by more than 6 hours, so it was not posted. Schedule it again or publish it now.`;
  return reason ? `${base} It was waiting because: ${reason}` : base;
}

/** The note on a post the daily limit moved to the next day. */
export function movedToNextDayNote(accountName: string, postsPerDay: number): string {
  const limit = postsPerDay === 1 ? "1 post" : `${postsPerDay} posts`;
  return `Moved to the next day: ${accountName} had already published ${limit} that day, the limit in Settings → LinkedIn → Sending rules.`;
}

/**
 * Why a scheduled post is not going out at its time, for the list and the
 * composer. Null when nothing is in the way.
 */
export function scheduledWaitReason(input: {
  unipileConnected: boolean;
  account: { status: "CONNECTED" | "DISCONNECTED"; name: string } | null;
  scheduledAt: Date;
  /** Posts the account has published (or is publishing) today. */
  publishedToday: number;
  postsPerDay: number;
  nextDayStart: Date;
}): string | null {
  if (!input.unipileConnected) return "Unipile is not connected, so scheduled posts wait until it is connected again.";
  if (!input.account) return "This post's LinkedIn account is no longer in your organization.";
  if (input.account.status !== "CONNECTED") {
    return `${input.account.name}'s LinkedIn account is disconnected. The post waits until it is reconnected, and fails if that is more than 6 hours after its time.`;
  }
  if (input.scheduledAt < input.nextDayStart && input.publishedToday >= input.postsPerDay) {
    const limit = input.postsPerDay === 1 ? "1 post" : `${input.postsPerDay} posts`;
    return `${input.account.name} has published ${limit} today, the daily limit. This post will move to the same time tomorrow.`;
  }
  return null;
}

/** The account's other posts within 4 hours of `at` (the composer warns; it does not refuse). */
export function nearbyPosts(at: Date, others: readonly PostTime[], excludeId: string | null): PostTime[] {
  return others.filter((other) => other.id !== excludeId && Math.abs(new Date(other.at).getTime() - at.getTime()) < NEARBY_POST_WARNING_MS);
}
