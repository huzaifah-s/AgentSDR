"use client";

import { useState } from "react";
import * as Button from "@/components/alignui/button";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useDialogs } from "@/components/DialogProvider";
import { Callout } from "@/components/settings/SettingsKit";
import type { ConnectedApp } from "@/lib/auth/connectedApps";
import { API_SCOPE_LABELS } from "@/lib/publicApi/access";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * Settings, Connected apps: the person's OAuth apps (src/lib/auth/connectedApps.ts).
 * Disconnecting revokes the app's access at once.
 */
export function ConnectedAppsSettings({ initialApps }: { initialApps: ConnectedApp[] }) {
  const dialogs = useDialogs();
  const [apps, setApps] = useState(initialApps);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function disconnect(app: ConnectedApp) {
    const confirmed = await dialogs.confirm({
      title: `Disconnect ${app.clientName}?`,
      description: "It loses access at once. To use it again, connect it again from the app.",
      confirmLabel: "Disconnect",
      variant: "error",
    });
    if (!confirmed) return;
    setBusy(app.id);
    setError("");
    try {
      const res = await fetch(`/api/settings/connected-apps/${app.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) return setError(data?.error || "Could not disconnect the app.");
      setApps((current) => current.filter((a) => a.id !== app.id));
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Callout tone="info">
        An AI assistant such as a claude.ai connector can connect to BraintreeSDR&apos;s MCP server by asking you to sign in
        and allow it. It then acts as you in the organization you chose, with only what you allowed.
      </Callout>
      {error && <Callout tone="error">{error}</Callout>}
      <Frame>
        <FrameHeader title="Apps" description={apps.length === 1 ? "1 connected" : `${apps.length} connected`} />
        <FramePanel>
          {apps.length === 0 ? (
            <p className="text-paragraph-sm text-text-sub-600">No apps connected.</p>
          ) : (
            <ul className="divide-y divide-stroke-soft-200">
              {apps.map((app) => (
                <li key={app.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-label-sm text-text-strong-950">{app.clientName}</p>
                    <p className="text-paragraph-xs text-text-sub-600">
                      {app.organizationName ?? "No organization"} · Connected {app.connectedAt ? dateFormat.format(new Date(app.connectedAt)) : "—"}
                      {app.stayConnected ? "" : " · Access for an hour at a time"}
                    </p>
                    <ul className="mt-1 list-disc pl-4 text-paragraph-xs text-text-sub-600">
                      {app.scopes.map((scope) => (
                        <li key={scope}>{API_SCOPE_LABELS[scope]}</li>
                      ))}
                    </ul>
                  </div>
                  <Button.Root variant="error" mode="ghost" size="xsmall" disabled={busy === app.id} onClick={() => void disconnect(app)}>
                    Disconnect
                  </Button.Root>
                </li>
              ))}
            </ul>
          )}
        </FramePanel>
      </Frame>
    </div>
  );
}
