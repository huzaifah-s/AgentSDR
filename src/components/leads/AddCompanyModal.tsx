"use client";

import { useState } from "react";
import { RiBuilding2Line } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Modal from "@/components/alignui/modal";
import { FormError, TextField } from "@/components/calls/fields";
import { parseCompanyDomain } from "@/lib/leads/identity";

export type SavedCompany = { id: string; name: string | null; domain: string };

/**
 * One company typed by hand (`POST /api/leads/companies`). Its domain is its
 * identity, as for every import and LinkedIn source: a domain the organization
 * already has updates that company. "Save and add a person" hands the company
 * to the Add person form, which links the person to it by that domain.
 */
export function AddCompanyModal({ onClose, onSaved }: {
  onClose: () => void;
  onSaved: (company: SavedCompany, next: "done" | "add-person") => void;
}) {
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const parsed = parseCompanyDomain(domain);
  const domainError = domain.trim() && !parsed ? "Enter a domain like acme.com — the company's website without https://" : "";

  async function submit(event: React.FormEvent | React.MouseEvent, next: "done" | "add-person") {
    event.preventDefault();
    if (!parsed) return setError(domain.trim() ? domainError : "A domain is required.");
    setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/leads/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, name, linkedinUrl }),
      });
      const data = await response.json().catch(() => ({})) as { company?: SavedCompany; error?: string };
      if (!response.ok || !data.company) throw new Error(data.error ?? "Could not save this company");
      onSaved(data.company, next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this company");
    } finally { setSubmitting(false); }
  }

  return (
    <Modal.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Content size="max-w-lg">
        <form onSubmit={(event) => void submit(event, "done")}>
          <Modal.Header icon={RiBuilding2Line}>
            <Modal.Title>Add company</Modal.Title>
            <Modal.Description>A company is identified by its domain. If it already exists, it is updated.</Modal.Description>
          </Modal.Header>
          <Modal.Body className="space-y-4">
            <div>
              <TextField label="Domain" value={domain} onChange={setDomain} placeholder="acme.com" autoFocus autoComplete="off" aria-invalid={Boolean(domainError)} />
              <p className={domainError ? "mt-1.5 text-paragraph-xs text-error-base" : "mt-1.5 text-paragraph-xs text-text-sub-600"}>
                {domainError || "The company's website. People are linked to it by this domain."}
              </p>
            </div>
            <TextField label="Name (optional)" value={name} onChange={setName} placeholder="Acme" autoComplete="off" />
            <TextField label="LinkedIn page (optional)" value={linkedinUrl} onChange={setLinkedinUrl} placeholder="linkedin.com/company/…" autoComplete="off" />
            {error && error !== domainError && <FormError>{error}</FormError>}
          </Modal.Body>
          <Modal.Footer>
            <Button.Root type="button" variant="neutral" mode="stroke" size="small" onClick={onClose}>Cancel</Button.Root>
            <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={!parsed || submitting} onClick={(event) => void submit(event, "add-person")}>Save and add a person</Button.Root>
            <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={!parsed || submitting}>{submitting ? "Saving…" : "Save"}</Button.Root>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
