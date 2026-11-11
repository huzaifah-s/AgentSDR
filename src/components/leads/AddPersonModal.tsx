"use client";

import { useState } from "react";
import { RiEditLine, RiUserAddLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Modal from "@/components/alignui/modal";
import * as Textarea from "@/components/alignui/textarea";
import { FormError, TextField } from "@/components/calls/fields";
import { CompanyNameField } from "@/components/calling/CompanyNameField";
import { personCompanyName } from "@/lib/leads/companyName";
import { inferCompanyDomainFromEmail, parseCompanyDomain } from "@/lib/leads/identity";
import type { PersonRow } from "./leadTypes";

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
 * Where the person's company will end up, by the rules `upsertPerson` applies
 * to every source: a company exists only with a domain — the one given, or the
 * work email's when only a name is — and the person is linked to it; a name
 * with no domain is kept on the person as text.
 */
function companyOutcome(fields: Fields): { tone: "linked" | "text" | "error"; message: string } | null {
  const name = fields.companyName.trim();
  const typedDomain = fields.companyDomain.trim();
  if (typedDomain) {
    const domain = parseCompanyDomain(typedDomain);
    return domain
      ? { tone: "linked", message: `Linked to the company ${domain}${name ? "" : " (created if new)"}.` }
      : { tone: "error", message: "Enter a domain like acme.com, or leave it empty." };
  }
  if (!name) return null;
  const fromEmail = inferCompanyDomainFromEmail(fields.email);
  return fromEmail
    ? { tone: "linked", message: `Linked to the company ${fromEmail}, from the email address.` }
    : { tone: "text", message: "Kept on the person as text only. Add the company's domain to link them to it." };
}

/** The form's fields for an existing person, as the Leads list returned it. */
function fieldsFromRow({ person, company }: PersonRow): Fields {
  // Older sources may hold only a full name; split it the simple way for editing.
  const [first = "", ...rest] = (person.firstName || person.lastName ? "" : person.fullName ?? "").trim().split(/\s+/);
  const notes = person.raw?.notes;
  return {
    firstName: person.firstName ?? first,
    lastName: person.lastName ?? rest.join(" "),
    email: person.email ?? "",
    linkedinUrl: person.linkedinUrl ? (person.linkedinUrl.includes("/") ? person.linkedinUrl : `linkedin.com/in/${person.linkedinUrl}`) : "",
    phone: person.phone ?? "",
    title: person.title ?? "",
    companyName: personCompanyName(person.raw, company?.name) ?? "",
    companyDomain: company?.domain ?? "",
    notes: typeof notes === "string" ? notes : "",
  };
}

/**
 * One person typed by hand, through the same path as a sheet import
 * (`POST /api/leads/people` → `upsertManualPerson`): an existing person with
 * that email or LinkedIn profile is updated, not duplicated, and no CRM record
 * is created — that begins with a reply or a call, as for imported people.
 * `company` prefills the company (from Add company → "Save and add a person").
 *
 * With `editing`, the same form edits that person instead
 * (`PATCH /api/leads/people/[id]`, `updatePerson`): every field is replaced,
 * an email or LinkedIn profile another person holds is refused, and clearing
 * the company fields unlinks the person from their company.
 */
export function AddPersonModal({ onClose, onSaved, company, editing }: {
  onClose: () => void;
  onSaved: () => void;
  company?: { name: string | null; domain: string };
  editing?: PersonRow;
}) {
  const initial: Fields = editing ? fieldsFromRow(editing) : company ? { ...EMPTY, companyName: company.name ?? "", companyDomain: company.domain } : EMPTY;
  const [fields, setFields] = useState<Fields>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ name: string; created: boolean; phoneDropped: boolean } | null>(null);

  const set = (key: keyof Fields) => (value: string) => setFields((current) => ({ ...current, [key]: value }));
  const hasIdentity = Boolean(fields.email.trim() || fields.linkedinUrl.trim());
  const linkedBefore = editing?.company ?? null;
  const outcome = companyOutcome(fields) ?? (linkedBefore
    ? { tone: "text" as const, message: `Removed from ${linkedBefore.name || linkedBefore.domain} when saved.` }
    : null);
  const canSave = hasIdentity && outcome?.tone !== "error";

  async function submit(event: React.FormEvent, addAnother: boolean) {
    event.preventDefault();
    if (!hasIdentity) return setError("Add an email address or a LinkedIn profile URL.");
    setSubmitting(true); setError("");
    if (editing) {
      try {
        const response = await fetch(`/api/leads/people/${editing.person.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields),
        });
        const data = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Could not save this person");
        onSaved();
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not save this person");
      } finally { setSubmitting(false); }
      return;
    }
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
        // The next person is usually a colleague: keep the company.
        setFields({ ...EMPTY, companyName: fields.companyName, companyDomain: fields.companyDomain });
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
          <Modal.Header icon={editing ? RiEditLine : RiUserAddLine}>
            <Modal.Title>{editing ? "Edit person" : "Add person"}</Modal.Title>
            <Modal.Description>{editing
              ? "An email or LinkedIn URL is required. Their CRM record and campaigns stay with them."
              : "An email or LinkedIn URL is required. A person who already exists is updated."}</Modal.Description>
          </Modal.Header>
          <Modal.Body className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="First name" value={fields.firstName} onChange={set("firstName")} autoFocus autoComplete="off" />
              <TextField label="Last name" value={fields.lastName} onChange={set("lastName")} autoComplete="off" />
              <TextField label="Email" type="email" value={fields.email} onChange={set("email")} placeholder="name@company.com" autoComplete="off" />
              <TextField label="LinkedIn URL" value={fields.linkedinUrl} onChange={set("linkedinUrl")} placeholder="linkedin.com/in/…" autoComplete="off" />
              <TextField label="Phone (optional)" type="tel" value={fields.phone} onChange={set("phone")} placeholder="+91 98765 43210" autoComplete="off" />
              <TextField label="Job title (optional)" value={fields.title} onChange={set("title")} autoComplete="off" />
              <CompanyNameField
                label="Company (optional)"
                value={fields.companyName}
                onChange={set("companyName")}
                onPick={(picked) => setFields((current) => ({ ...current, companyName: picked.name ?? "", companyDomain: picked.domain }))}
              />
              <TextField label="Company domain (optional)" value={fields.companyDomain} onChange={set("companyDomain")} placeholder="company.com" autoComplete="off" />
            </div>
            {outcome && (
              <p className={outcome.tone === "error" ? "-mt-2 text-paragraph-xs text-error-base" : outcome.tone === "text" ? "-mt-2 text-paragraph-xs text-warning-base" : "-mt-2 text-paragraph-xs text-text-sub-600"}>
                {outcome.message}
              </p>
            )}
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
            {!editing && <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={!canSave || submitting} onClick={(event) => void submit(event, true)}>Save and add another</Button.Root>}
            <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={!canSave || submitting}>{submitting ? "Saving…" : "Save"}</Button.Root>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
