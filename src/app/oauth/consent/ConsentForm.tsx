"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";
import { ErrorCallout, SecondaryButton, SubmitButton } from "@/components/auth/fields";
import { API_SCOPE_LABELS, type ApiScope } from "@/lib/publicApi/access";

/**
 * The scopes an app asked for, each with what it allows. Read access stays
 * ticked (the app can do nothing without it); changes can be left out, and
 * the app then gets read access only. Better Auth's client follows the
 * `{ redirect, url }` the consent answers with, back to the app.
 */
export function ConsentForm({
  scopes,
  offlineAccess,
  clientName,
  clientUri,
}: {
  scopes: ApiScope[];
  offlineAccess: boolean;
  clientName: string;
  clientUri: string | null;
}) {
  const [allowWrite, setAllowWrite] = useState(true);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState("");

  async function answer(accept: boolean) {
    setError("");
    setBusy(accept ? "allow" : "deny");
    const granted = scopes.filter((scope) => scope !== "campaigns:write" || allowWrite);
    const result = await authClient.$fetch<{ redirect?: boolean; url?: string }>("/oauth2/consent", {
      method: "POST",
      body: accept ? { accept: true, scope: [...granted, ...(offlineAccess ? ["offline_access"] : [])].join(" ") } : { accept: false },
    });
    if (result.error) {
      setError(result.error.message || "This request has expired. Start connecting again from the app.");
      setBusy(null);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void answer(true);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error && <ErrorCallout>{error}</ErrorCallout>}
      <ul className="flex flex-col gap-2">
        {scopes.map((scope) => (
          <li key={scope} className="flex items-start gap-3 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-2.5 text-sm text-zinc-100">
            {scope === "campaigns:write" ? (
              <input
                type="checkbox"
                id="allow-write"
                checked={allowWrite}
                onChange={(e) => setAllowWrite(e.target.checked)}
                className="mt-0.5 accent-[#335cff]"
              />
            ) : (
              <input type="checkbox" checked disabled aria-label="Always included" className="mt-0.5 accent-[#335cff]" />
            )}
            <label htmlFor={scope === "campaigns:write" ? "allow-write" : undefined}>{API_SCOPE_LABELS[scope]}</label>
          </li>
        ))}
      </ul>
      <p className="text-xs leading-relaxed text-zinc-400">
        {offlineAccess ? `${clientName} stays connected until you disconnect it` : `${clientName} gets access for about an hour`}
        , in Settings, Connected apps. It stops at once if you leave the organization.
        {clientUri && (
          <>
            {" "}
            App website: <span className="break-all text-zinc-300">{clientUri}</span>
          </>
        )}
      </p>
      <SubmitButton loading={busy === "allow"} loadingLabel="Allowing…" disabled={busy !== null}>
        Allow
      </SubmitButton>
      <SecondaryButton loading={busy === "deny"} disabled={busy !== null} onClick={() => void answer(false)}>
        Don&apos;t allow
      </SecondaryButton>
    </form>
  );
}
