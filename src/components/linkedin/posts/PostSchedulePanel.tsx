"use client";

import { useState } from "react";
import { RiCalendarScheduleLine, RiCalendarCloseLine, RiErrorWarningLine, RiLoader4Line } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { MIN_SCHEDULE_LEAD_MS, type LinkedinPostView, type PostTime } from "@/lib/linkedin/posts/contract";
import { nearbyPosts, scheduleInputs, scheduleInstant } from "@/lib/linkedin/posts/scheduleRules";
import { cn } from "@/utils/cn";

/** A time as the organization reads it: "Thu, Nov 13, 9:30 AM". */
export function formatInZone(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** The default suggestion: an hour from now, on the next quarter hour. */
function suggestedTime(timeZone: string): { date: string; time: string } {
  const quarter = 15 * 60 * 1000;
  return scheduleInputs(timeZone, new Date(Math.ceil((Date.now() + 60 * 60 * 1000) / quarter) * quarter));
}

type Props = {
  post: LinkedinPostView | null;
  timeZone: string;
  accountName: string;
  /** The chosen account's scheduled and recently published posts. */
  otherPosts: PostTime[];
  disabled: boolean;
  busy: boolean;
  /** Text is there and within the limit, an account is chosen and connected. */
  canSchedule: boolean;
  onSchedule: (date: string, time: string) => Promise<void>;
  onUnschedule: () => Promise<void>;
};

export function PostSchedulePanel({ post, timeZone, accountName, otherPosts, disabled, busy, canSchedule, onSchedule, onUnschedule }: Props) {
  const scheduled = post?.status === "scheduled" && post.scheduledAt ? post.scheduledAt : null;
  const [value, setValue] = useState(() => (scheduled ? scheduleInputs(timeZone, new Date(scheduled)) : suggestedTime(timeZone)));
  const instant = scheduleInstant(timeZone, value.date, value.time);
  const tooSoon = instant ? instant.getTime() - Date.now() < MIN_SCHEDULE_LEAD_MS : false;
  const nearby = instant ? nearbyPosts(instant, otherPosts, post?.id ?? null) : [];
  const unchanged = Boolean(scheduled && instant && instant.getTime() === new Date(scheduled).getTime());

  return (
    <Frame>
      <FrameHeader
        title="Schedule"
        description={`Times are in your organization's time zone, ${timeZone.replace(/_/g, " ")} (Settings → Organization).`}
      />
      <FramePanel className="space-y-3">
        {scheduled && (
          <p className="text-paragraph-sm text-text-strong-950">
            Scheduled for <strong className="font-medium">{formatInZone(scheduled, timeZone)}</strong> on {accountName}&apos;s profile. Edits keep it scheduled.
          </p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-label-xs text-text-sub-600">
            Date
            <Input.Root size="small" className="w-40">
              <Input.Wrapper>
                <Input.Input type="date" value={value.date} disabled={disabled} onChange={(event) => setValue((v) => ({ ...v, date: event.target.value }))} />
              </Input.Wrapper>
            </Input.Root>
          </label>
          <label className="flex flex-col gap-1 text-label-xs text-text-sub-600">
            Time
            <Input.Root size="small" className="w-32">
              <Input.Wrapper>
                <Input.Input type="time" value={value.time} disabled={disabled} onChange={(event) => setValue((v) => ({ ...v, time: event.target.value }))} />
              </Input.Wrapper>
            </Input.Root>
          </label>
          <Button.Root
            variant="primary"
            mode={scheduled ? "stroke" : "filled"}
            size="small"
            disabled={disabled || !canSchedule || !instant || tooSoon || unchanged}
            onClick={() => onSchedule(value.date, value.time)}
          >
            <Button.Icon as={busy ? RiLoader4Line : RiCalendarScheduleLine} className={cn(busy && "animate-spin")} />
            {scheduled ? "Change time" : "Schedule"}
          </Button.Root>
          {scheduled && (
            <Button.Root variant="neutral" mode="ghost" size="small" disabled={disabled} onClick={onUnschedule}>
              <Button.Icon as={RiCalendarCloseLine} />
              Unschedule
            </Button.Root>
          )}
        </div>
        {!instant && <p className="text-paragraph-xs text-error-base">Choose a date and time.</p>}
        {instant && tooSoon && <p className="text-paragraph-xs text-error-base">Choose a time at least 5 minutes from now.</p>}
        {nearby.length > 0 && (
          <p className="flex gap-1.5 text-paragraph-xs text-warning-base">
            <RiErrorWarningLine className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {accountName} has another post within 4 hours of this time (
              {nearby.map((other) => `${other.status === "scheduled" ? "scheduled" : "published"} ${formatInZone(other.at, timeZone)}`).join("; ")}). Posts close together
              compete for the same readers. You can still schedule it.
            </span>
          </p>
        )}
        {!scheduled && (
          <p className="text-paragraph-xs text-text-soft-400">
            It goes out within a few minutes of its time, counted in that day&apos;s limit. If it cannot go out within 6 hours of its time, it fails instead of posting late.
          </p>
        )}
      </FramePanel>
    </Frame>
  );
}
