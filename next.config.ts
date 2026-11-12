import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import pkg from "./package.json";

/** The dev server's memory target, in MB (TURBOPACK_MEMORY_LIMIT_MB to change it). */
const DEV_MEMORY_LIMIT_MB = Number(process.env.TURBOPACK_MEMORY_LIMIT_MB) || 4096;

const nextConfig = (phase: string): NextConfig => ({
  output: "standalone",

  // This folder, never a parent. Next.js otherwise takes the outermost
  // lockfile as the root, so a dev server in a git worktree under
  // .claude/worktrees/ took the main checkout as its project — every other
  // worktree included — and grew past 10 GB.
  turbopack: { root: __dirname },

  // Turbopack keeps every route it has compiled in memory, which on this app
  // reached 12 GB in an hour of `next dev`. In dev it aims to stay under this
  // and evicts its caches to do so; builds are left as they were.
  ...(phase === PHASE_DEVELOPMENT_SERVER ? { experimental: { turbopackMemoryLimit: DEV_MEMORY_LIMIT_MB * 1024 * 1024 } } : {}),

  // A second dev server beside the usual one (e.g. the demo, DEMO_MODE=true,
  // on its own database) needs its own build directory: two `next dev` in one
  // folder otherwise fight over .next's lock.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // package.json's version, inlined into client code for the Help menu's bug-report link.
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },

  // The formula sandbox reads these library sources off disk at runtime and
  // evaluates them inside the QuickJS isolate (src/lib/grid/runners/sandbox.ts).
  // A readFileSync path is invisible to Next's module tracer, so without this
  // they are missing from the standalone output and every formula fails with
  // "_ is not defined" in production but works in dev.
  outputFileTracingIncludes: {
    "/api/grid/**": [
      "./node_modules/lodash/lodash.min.js",
      "./node_modules/moment/min/moment.min.js",
      "./node_modules/@formulajs/formulajs/lib/browser/formula.min.js",
    ],
    // The Call Recorder zip, built by `bun run build` and read off disk by the download route.
    "/downloads/call-recorder": ["./extensions/whatsapp-recorder/release/agentsdr-call-recorder.zip"],
  },

  async redirects() {
    // The enrichment grid moved from /grid to /tables, to match what the
    // sidebar has always called it. Existing bookmarks and already-open tabs
    // still point at the old path. Deliberately NOT permanent: a 308 is
    // cached by the browser indefinitely, which would be painful to undo,
    // and there is no SEO to preserve on an authenticated internal tool.
    // Query strings (?folder=, ?table=) are carried over automatically.
    return [
      { source: "/grid", destination: "/tables", permanent: false },
      { source: "/grid/:path*", destination: "/tables/:path*", permanent: false },

      // Settings screens moved into the settings box (src/app/settings). The
      // LinkedIn one matters beyond bookmarks: a Unipile hosted-auth flow
      // started before the move returns to /linkedin/accounts?unipile=…, and
      // the query string is carried over to the page that handles it.
      { source: "/crm/settings", destination: "/settings/lead-categories", permanent: false },
      { source: "/crm/knowledge", destination: "/settings/knowledge", permanent: false },
      { source: "/outreach/mailboxes", destination: "/settings/email-accounts", permanent: false },
      { source: "/linkedin/accounts", destination: "/settings/linkedin-accounts", permanent: false },
      { source: "/calling/accounts", destination: "/settings/whatsapp-accounts", permanent: false },
      // Integrations moved into each channel's own Connection page.
      { source: "/settings/integrations", destination: "/settings/email-connection", permanent: false },

      // People and Companies are the two tabs of Leads.
      { source: "/people", destination: "/leads", permanent: false },
      { source: "/companies", destination: "/leads?tab=companies", permanent: false },
    ];
  },
});

export default nextConfig;
