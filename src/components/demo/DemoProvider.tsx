"use client";

import * as React from "react";
import { RiCloseLine, RiLockLine } from "@remixicon/react";

import { DEMO_READ_ONLY_CODE } from "@/lib/demo/mode";

const DemoContext = React.createContext(false);

/** True on the public demo (DEMO_MODE), where every change is refused. */
export function useDemoMode(): boolean {
  return React.useContext(DemoContext);
}

/**
 * Wraps the app on the public demo. The proxy answers every write with 403
 * DEMO_READ_ONLY; the ~175 places that call fetch each show errors their own
 * way, so this watches fetch once and, on that answer, shows one calm notice
 * instead of leaving each screen to word it.
 */
export function DemoProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [notice, setNotice] = React.useState(0);

  React.useEffect(() => {
    if (!enabled) return;
    const original = window.fetch;
    const watched = async (...args: Parameters<typeof fetch>) => {
      // Called on window: WebKit (Safari, every iPhone browser) may refuse a
      // detached fetch, and then every request on the page fails.
      const response = await original.apply(window, args);
      // Only a change the visitor asked for: a read the demo refuses (a
      // page's background request) is the page's own business to show.
      const [input, init] = args;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (response.status === 403 && method !== "GET" && method !== "HEAD") {
        response
          .clone()
          .json()
          .then((body: { code?: string }) => {
            if (body?.code === DEMO_READ_ONLY_CODE) setNotice((n) => n + 1);
          })
          .catch(() => undefined);
      }
      return response;
    };
    window.fetch = Object.assign(watched, original);
    return () => {
      window.fetch = original;
    };
  }, [enabled]);

  return (
    <DemoContext.Provider value={enabled}>
      {children}
      {enabled && notice > 0 && <ReadOnlyToast key={notice} onClose={() => setNotice(0)} />}
    </DemoContext.Provider>
  );
}

function ReadOnlyToast({ onClose }: { onClose: () => void }) {
  React.useEffect(() => {
    const timer = window.setTimeout(onClose, 5000);
    return () => window.clearTimeout(timer);
  }, [onClose]);

  return (
    <div
      role="status"
      // static-black, not bg-strong-950: that token flips to near-white in dark mode, which left white text on a white box.
      className="fixed inset-x-4 bottom-4 z-[100] mx-auto flex max-w-md items-start gap-3 rounded-xl bg-static-black p-3.5 text-static-white shadow-regular-md ring-1 ring-inset ring-white/10 animate-in fade-in-0 slide-in-from-bottom-2 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
        <RiLockLine className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-label-sm">This is a read-only demo</p>
        <p className="mt-0.5 text-paragraph-xs text-white/70">Look around as much as you like. Changes are not saved here.</p>
      </div>
      <button type="button" onClick={onClose} aria-label="Dismiss" className="rounded-md p-0.5 text-white/60 transition hover:text-static-white">
        <RiCloseLine className="size-4" />
      </button>
    </div>
  );
}

/** The strip across the top of the demo: what this is. */
export function DemoBanner() {
  const enabled = useDemoMode();
  if (!enabled) return null;
  return (
    <div className="flex h-10 shrink-0 items-center justify-center gap-3 border-b border-stroke-soft-200 bg-bg-weak-50 px-4 text-paragraph-sm text-text-sub-600">
      <span className="flex min-w-0 items-center gap-2">
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success-base opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-success-base" />
        </span>
        <span className="truncate">
          <span className="text-label-sm text-text-strong-950">Live demo</span>
          <span className="hidden sm:inline"> · sample data: the people and conversations are made up, and nothing you change is saved</span>
        </span>
      </span>
    </div>
  );
}
