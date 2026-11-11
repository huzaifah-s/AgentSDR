"use client";

import { useState } from "react";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import * as Select from "@/components/alignui/select";
import * as Textarea from "@/components/alignui/textarea";
import { FormError } from "@/components/calls/fields";

export type LogUpdateResult = {
  eventId: string;
  crmRecordId: string;
  recordCreated: boolean;
  followUp: { scheduled: true; at: string } | { scheduled: false; reason: string } | null;
};

import { LOGGED_KINDS as KINDS } from "./loggedKinds";

/** For a datetime-local input: local time, minutes precision. */
function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);

/**
 * Log something that happened outside the app — a call from the rep's phone,
 * a WhatsApp from their own number, a meeting — on the person
 * (POST /api/leads/people/:id/activity). The first one gives the person a CRM
 * record; a follow-up date puts them in Action required on that day.
 */
export function LogUpdateForm({ personId, onLogged, onCancel, framed = true }: {
  personId: string;
  /** Inside a dialog the dialog is the frame. */
  framed?: boolean;
  onLogged: (result: LogUpdateResult) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<string>("call");
  const [direction, setDirection] = useState<"outbound" | "inbound">("outbound");
  const [occurredAt, setOccurredAt] = useState(() => toLocalInput(new Date()));
  const [summary, setSummary] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true); setError("");
    try {
      const response = await fetch(`/api/leads/people/${encodeURIComponent(personId)}/activity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, direction, summary, occurredAt: fromLocalInput(occurredAt), followUpAt: fromLocalInput(followUpAt) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "The update was not saved");
      onLogged(data as LogUpdateResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The update was not saved");
    } finally {
      setSaving(false);
    }
  };

  const id = (field: string) => `log-${field}-${personId}`;
  return (
    <form className={framed ? "space-y-3 rounded-xl p-3 ring-1 ring-inset ring-stroke-soft-200" : "space-y-3"} onSubmit={(event) => { event.preventDefault(); if (summary.trim() && !saving) void save(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className="mb-1.5 block text-label-xs text-text-sub-600">What</span>
          <Select.Root size="small" value={kind} onValueChange={setKind} disabled={saving}>
            <Select.Trigger aria-label="What happened"><Select.Value /></Select.Trigger>
            <Select.Content>{KINDS.map((option) => <Select.Item key={option.value} value={option.value}>{option.label}</Select.Item>)}</Select.Content>
          </Select.Root>
        </div>
        <div>
          <label htmlFor={id("when")} className="mb-1.5 block text-label-xs text-text-sub-600">When</label>
          <Input.Root size="small">
            <Input.Wrapper><Input.Input id={id("when")} type="datetime-local" value={occurredAt} max={toLocalInput(new Date())} onChange={(event) => setOccurredAt(event.target.value)} disabled={saving} /></Input.Wrapper>
          </Input.Root>
        </div>
      </div>
      <SegmentedControl.Root value={direction} onValueChange={(value) => setDirection(value as "outbound" | "inbound")}>
        <SegmentedControl.List aria-label="Direction">
          <SegmentedControl.Trigger value="outbound" disabled={saving}>We reached out</SegmentedControl.Trigger>
          <SegmentedControl.Trigger value="inbound" disabled={saving}>They replied</SegmentedControl.Trigger>
        </SegmentedControl.List>
      </SegmentedControl.Root>
      <Textarea.Root simple rows={4} aria-label="Summary" value={summary} onChange={(event) => setSummary(event.target.value)} disabled={saving} placeholder={direction === "inbound" ? "What did they say? e.g. Interested, call back Thursday afternoon" : "What happened? e.g. Called, no answer; left a voicemail"} />
      <div>
        <label htmlFor={id("follow-up")} className="mb-1.5 block text-label-xs text-text-sub-600">Next follow-up <span className="text-text-soft-400">(optional)</span></label>
        <Input.Root size="small">
          <Input.Wrapper><Input.Input id={id("follow-up")} type="datetime-local" value={followUpAt} min={toLocalInput(new Date())} onChange={(event) => setFollowUpAt(event.target.value)} disabled={saving} /></Input.Wrapper>
        </Input.Root>
        <p className="mt-1 text-paragraph-xs text-text-soft-400">They show in Action required on this date.</p>
      </div>
      {error && <FormError>{error}</FormError>}
      <div className="flex justify-end gap-2">
        <Button.Root type="button" variant="neutral" mode="ghost" size="xsmall" onClick={onCancel} disabled={saving}>Cancel</Button.Root>
        <Button.Root type="submit" variant="primary" mode="filled" size="xsmall" disabled={!summary.trim() || saving}>{saving ? "Saving…" : "Log update"}</Button.Root>
      </div>
    </form>
  );
}
