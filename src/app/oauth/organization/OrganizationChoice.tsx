"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";
import { ErrorCallout, SubmitButton } from "@/components/auth/fields";
import type { OAuthOrganizationChoice } from "@/lib/auth/oauthPages.server";

/**
 * Makes the chosen organization the session's active one and records the
 * choice (/api/oauth/organization, on the server: see why there), then
 * continues the authorization.
 * Better Auth's client follows the `{ redirect, url }` it answers with.
 */
export function OrganizationChoice({ choices, activeOrganizationId }: { choices: OAuthOrganizationChoice[]; activeOrganizationId: string | null }) {
  const [selected, setSelected] = useState(
    choices.find((choice) => choice.id === activeOrganizationId)?.id ?? choices[0]?.id ?? "",
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setError("");
    setLoading(true);
    const chosen = await fetch("/api/oauth/organization", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: selected }),
    }).catch(() => null);
    if (!chosen?.ok) {
      const data = await chosen?.json().catch(() => null);
      setError(data?.error || "Could not use that organization. Try again.");
      setLoading(false);
      return;
    }
    const next = await authClient.$fetch<{ redirect?: boolean; url?: string }>("/oauth2/continue", {
      method: "POST",
      body: { postLogin: true },
    });
    if (next.error) {
      setError(next.error.message || "This request has expired. Start connecting again from the app.");
      setLoading(false);
    }
  }

  if (choices.length === 0) {
    return <ErrorCallout>You are not a member of any organization, so there is nothing to connect.</ErrorCallout>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error && <ErrorCallout>{error}</ErrorCallout>}
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Organization</legend>
        {choices.map((choice) => (
          <label
            key={choice.id}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-2.5 text-sm text-zinc-100 has-[:checked]:border-[#335cff]/60 has-[:checked]:bg-[#335cff]/10"
          >
            <input
              type="radio"
              name="organization"
              value={choice.id}
              checked={selected === choice.id}
              onChange={() => setSelected(choice.id)}
              className="accent-[#335cff]"
            />
            {choice.name}
          </label>
        ))}
      </fieldset>
      <SubmitButton loading={loading} loadingLabel="Continuing…" disabled={!selected}>
        Continue
      </SubmitButton>
    </form>
  );
}
