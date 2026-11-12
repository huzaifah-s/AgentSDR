/**
 * The public demo: a deployment with DEMO_MODE=true lets anyone browse the
 * app with no sign-in, read-only, on a database holding only the fictional
 * organization from scripts/db/seed-demo.ts.
 *
 * - A visitor without a session goes to /demo, which signs them in as the
 *   demo user (src/app/demo/route.ts). The sign-in screens redirect there too.
 * - Every mutating request is refused in the proxy (demoRequestBlock), so
 *   nothing a visitor clicks changes the data another visitor sees.
 * - Nothing runs in the background (src/instrumentation.ts), and there is no
 *   cron: the demo never sends, syncs or calls a model.
 *
 * Never set DEMO_MODE on a deployment whose database holds real data: every
 * visitor is signed in as the demo user with no password.
 *
 * Imported by the proxy, so it must stay free of server-only imports.
 */

import { enabled } from "@/lib/migration/controls";

type Environment = Record<string, string | undefined>;

export function isDemoMode(env: Environment = process.env): boolean {
  return enabled(env.DEMO_MODE);
}

/** The demo user the seed creates; /demo signs every visitor in as them. */
export const DEMO_USER_EMAIL = "demo@example.com";
export const DEMO_DEFAULT_PASSWORD = "demo-password-123";

export const DEMO_READ_ONLY_CODE = "DEMO_READ_ONLY";
export const DEMO_READ_ONLY_MESSAGE = "This is a read-only demo, so changes are not saved.";

/** Screens that would ask for a password or create an account: in the demo they lead in instead. */
const AUTH_SCREENS = ["/login", "/sign-in", "/sign-up", "/forgot-password", "/reset-password", "/accept-invitation", "/onboarding", "/setup"];

/**
 * Better Auth: its GET endpoints read (session, organization, members,
 * teams), except these, which act on a token or start a sign-in.
 */
const AUTH_ACTIVE_GETS = ["/api/auth/verify-email", "/api/auth/callback/", "/api/auth/reset-password/", "/api/auth/magic-link", "/api/auth/delete-user"];

/** The one Better Auth write a demo visitor may make: switching organization. */
const AUTH_ALLOWED_POSTS = ["/api/auth/organization/set-active"];

/** POSTs that only read or render: they are let through. */
const READ_ONLY_POSTS: RegExp[] = [
  /^\/api\/grid\/tables\/[^/]+\/export$/,
  /^\/api\/grid\/tables\/[^/]+\/formula-preview$/,
];

/**
 * Writes the UI fires on its own when something opens (marking a thread or
 * chat read). Refusing them would only surface an error nobody caused, so
 * they answer success without doing anything.
 */
const SILENT_WRITES: RegExp[] = [
  /^\/api\/outreach\/inbox\/messages\/[^/]+\/opened$/,
  /^\/api\/whatsapp\/chats\/[^/]+\/read$/,
];

/**
 * GETs that start work: model calls or the qualification job runner.
 * Refused like a mutation. (The OpenRouter model list answers from a fixed
 * catalog in the demo instead: src/lib/demo/openrouterCatalog.ts.)
 */
const ACTIVE_GETS: RegExp[] = [
  /^\/api\/debug-env/,
  /^\/api\/qualify/,
  /^\/api\/campaigns\/[^/]+\/stream$/,
];

export type DemoBlock =
  | { kind: "enter" }
  | { kind: "refuse" }
  | { kind: "silent" }
  | null;

/**
 * What the proxy does with a request in the demo: send it to /demo
 * ("enter"), refuse it as read-only, answer success without doing anything
 * ("silent"), or let it through (null).
 */
export function demoRequestBlock(pathname: string, method: string, env: Environment = process.env): DemoBlock {
  if (!isDemoMode(env)) return null;
  const m = method.toUpperCase();

  if (AUTH_SCREENS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return { kind: "enter" };

  if (pathname.startsWith("/api/auth/")) {
    if (m === "GET" || m === "HEAD") return AUTH_ACTIVE_GETS.some((p) => pathname.startsWith(p)) ? { kind: "refuse" } : null;
    return AUTH_ALLOWED_POSTS.includes(pathname) ? null : { kind: "refuse" };
  }

  if (m === "GET" || m === "HEAD" || m === "OPTIONS") {
    return ACTIVE_GETS.some((re) => re.test(pathname)) ? { kind: "refuse" } : null;
  }

  if (SILENT_WRITES.some((re) => re.test(pathname))) return { kind: "silent" };
  if (READ_ONLY_POSTS.some((re) => re.test(pathname))) return null;
  return { kind: "refuse" };
}
