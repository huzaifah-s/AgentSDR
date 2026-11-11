"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RiSendPlaneLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import * as Textarea from "@/components/alignui/textarea";
import { FormError } from "@/components/calls/fields";

type Mailbox = { id: string; emailAddress: string; displayName: string | null; status: string };

/**
 * Writes one email to a person from a connected Google Workspace mailbox
 * (POST /api/leads/people/:id/email). The server holds it to the mailbox's
 * daily limit and sending gap and refuses Do Not Contact and suppressed
 * addresses; its message is shown as it comes.
 */
export function PersonEmailComposer({ personId, to, onSent, onCancel }: {
  personId: string;
  to: string;
  onSent: (from: string) => void;
  onCancel: () => void;
}) {
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
  const [mailboxId, setMailboxId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void fetch("/api/outreach/mailboxes").then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!live) return;
      if (!response.ok) { setError(typeof data.error === "string" ? data.error : "Unable to load mailboxes"); setMailboxes([]); return; }
      const connected = (Array.isArray(data.mailboxes) ? data.mailboxes as Mailbox[] : []).filter((mailbox) => mailbox.status === "connected");
      setMailboxes(connected);
      if (connected.length === 1) setMailboxId(connected[0].id);
    }).catch(() => { if (live) { setError("Unable to load mailboxes"); setMailboxes([]); } });
    return () => { live = false; };
  }, []);

  const send = async () => {
    setSending(true); setError("");
    try {
      const response = await fetch(`/api/leads/people/${encodeURIComponent(personId)}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailboxId, subject, body }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "The email was not sent");
      onSent(String(data.from ?? ""));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The email was not sent");
    } finally {
      setSending(false);
    }
  };

  if (mailboxes && !mailboxes.length && !error) {
    return (
      <div className="space-y-2 rounded-xl bg-bg-weak-50 p-3 text-paragraph-sm text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
        <p>No connected mailbox can send yet. Connect Google Workspace and add a mailbox first.</p>
        <div className="flex gap-2">
          <Button.Root asChild variant="neutral" mode="stroke" size="xsmall"><Link href="/settings/email-accounts">Email settings</Link></Button.Root>
          <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={onCancel}>Close</Button.Root>
        </div>
      </div>
    );
  }

  const ready = Boolean(mailboxId && subject.trim() && body.trim()) && !sending;
  return (
    <form className="space-y-3 rounded-xl p-3 ring-1 ring-inset ring-stroke-soft-200" onSubmit={(event) => { event.preventDefault(); if (ready) void send(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className="mb-1.5 block text-label-xs text-text-sub-600">From</span>
          <Select.Root size="small" value={mailboxId} onValueChange={setMailboxId} disabled={!mailboxes || sending}>
            <Select.Trigger aria-label="Send from mailbox"><Select.Value placeholder={mailboxes ? "Choose a mailbox" : "Loading…"} /></Select.Trigger>
            <Select.Content>
              {(mailboxes ?? []).map((mailbox) => <Select.Item key={mailbox.id} value={mailbox.id}>{mailbox.displayName ? `${mailbox.displayName} · ${mailbox.emailAddress}` : mailbox.emailAddress}</Select.Item>)}
            </Select.Content>
          </Select.Root>
        </div>
        <div>
          <span className="mb-1.5 block text-label-xs text-text-sub-600">To</span>
          <p className="truncate py-1.5 text-paragraph-sm text-text-strong-950" title={to}>{to}</p>
        </div>
      </div>
      <div>
        <label htmlFor={`email-subject-${personId}`} className="mb-1.5 block text-label-xs text-text-sub-600">Subject</label>
        <Input.Root size="small">
          <Input.Wrapper>
            <Input.Input id={`email-subject-${personId}`} value={subject} maxLength={300} onChange={(event) => setSubject(event.target.value)} disabled={sending} />
          </Input.Wrapper>
        </Input.Root>
      </div>
      <Textarea.Root simple rows={7} aria-label="Message" value={body} onChange={(event) => setBody(event.target.value)} disabled={sending} placeholder="Write your email… The mailbox's signature is added when it has one." />
      {error && <FormError>{error}</FormError>}
      <div className="flex justify-end gap-2">
        <Button.Root type="button" variant="neutral" mode="ghost" size="xsmall" onClick={onCancel} disabled={sending}>Cancel</Button.Root>
        <Button.Root type="submit" variant="primary" mode="filled" size="xsmall" disabled={!ready}><Button.Icon as={RiSendPlaneLine} />{sending ? "Sending…" : "Send email"}</Button.Root>
      </div>
    </form>
  );
}
