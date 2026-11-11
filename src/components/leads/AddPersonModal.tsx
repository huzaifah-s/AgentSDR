"use client";

import { useState } from "react";
import { RiUserAddLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Modal from "@/components/alignui/modal";
import * as Textarea from "@/components/alignui/textarea";
import { FormError, TextField } from "@/components/calls/fields";

type Fields = {
  firstName: string;
  lastName: string;
  email: string;
  linkedinUrl: string;
  phone: string;
  title: string;
  companyName: string;
  companyDomain: string;
  notes: string;
};

type CreateResult = { personId: string; created: boolean; phone: string | null };

const EMPTY: Fields = { firstName: "", lastName: "", email: "", linkedinUrl: "", phone: "", title: "", companyName: "", companyDomain: "", notes: "" };

/**
 * One person typed by hand, through the same path as a sheet import
 * (`POST /api/leads/people` → `upsertManualPerson`): an existing person with
 * that email or LinkedIn profile is updated, not duplicated, and no CRM record
 * is created — that begins with a reply or a call, as for imported people.
 */
export function AddPersonModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ name: string; created: boolean; phoneDropped: boolean } | null>(null);

  const set = (key: keyof Fields) => (value: string) => setFields((current) => ({ ...current, [key]: value }));
  const hasIdentity = Boolean(fields.email.trim() || fields.linkedinUrl.trim());

  async function submit(event: React.FormEvent, addAnother: boolean) {
    event.preventDefault();
    if (!hasIdentity) return setError("Add an email address or a LinkedIn profile URL.");
    setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/leads/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const data = await response.json().catch(() => ({})) as Partial<CreateResult> & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not save this person");
      const name = [fields.firstName, fields.lastName].map((part) => part.trim()).filter(Boolean).join(" ") || fields.email.trim() || fields.linkedinUrl.trim();
      const result = { name, created: Boolean(data.created), phoneDropped: Boolean(fields.phone.trim()) && !data.phone };
      onSaved();
      if (addAnother) {
        setFields(EMPTY);
        setSaved(result);
      } else if (result.phoneDropped) {
        // Keep the modal open so the warning is seen; the person is saved.
        setSaved(result);
      } else {
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this person");
    } finally { setSubmitting(false); }
  }

  return (
    <Modal.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Content size="max-w-xl">
        <form onSubmit={(event) => void submit(event, false)}>
          <Modal.Header icon={RiUserAddLine}>
            <Modal.Title>Add person</Modal.Title>
            <Modal.Description>An email or LinkedIn URL is required. A person who already exists is updated.</Modal.Description>
          </Modal.Header>
          <Modal.Body className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="First name" value={fields.firstName} onChange={set("firstName")} autoFocus autoComplete="off" />
              <TextField label="Last name" value={fields.lastName} onChange={set("lastName")} autoComplete="off" />
              <TextField label="Email" type="email" value={fields.email} onChange={set("email")} placeholder="name@company.com" autoComplete="off" />
              <TextField label="LinkedIn URL" value={fields.linkedinUrl} onChange={set("linkedinUrl")} placeholder="linkedin.com/in/…" autoComplete="off" />
              <TextField label="Phone (optional)" type="tel" value={fields.phone} onChange={set("phone")} placeholder="+91 98765 43210" autoComplete="off" />
              <TextField label="Job title (optional)" value={fields.title} onChange={set("title")} autoComplete="off" />
              <TextField label="Company (optional)" value={fields.companyName} onChange={set("companyName")} autoComplete="off" />
              <TextField label="Company domain (optional)" value={fields.companyDomain} onChange={set("companyDomain")} placeholder="company.com" autoComplete="off" />
            </div>
            <div>
              <label htmlFor="add-person-notes" className="mb-1.5 block text-label-sm text-text-strong-950">Notes <span className="text-text-soft-400">(optional)</span></label>
              <Textarea.Root id="add-person-notes" simple rows={2} value={fields.notes} onChange={(event) => set("notes")(event.target.value)} />
            </div>
            {error && <FormError>{error}</FormError>}
            {saved && !error && (
              <p role="status" className="rounded-lg bg-bg-weak-50 px-3 py-2 text-paragraph-xs text-text-sub-600">
                {saved.created ? "Added" : "Updated"} {saved.name}.
                {saved.phoneDropped && <span className="text-warning-base"> The phone number was not recognised, so it was not saved — include the country code, e.g. +91.</span>}
              </p>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button.Root type="button" variant="neutral" mode="stroke" size="small" onClick={onClose}>{saved ? "Done" : "Cancel"}</Button.Root>
            <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={!hasIdentity || submitting} onClick={(event) => void submit(event, true)}>Save and add another</Button.Root>
            <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={!hasIdentity || submitting}>{submitting ? "Saving…" : "Save"}</Button.Root>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
