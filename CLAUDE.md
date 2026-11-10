# AgentSDR_v2

## TypeScript, not JavaScript

Write all new code in TypeScript (`.ts` / `.tsx`). Do not add new `.js` or `.mjs`
files, including one-off tooling — a throwaway script tends not to stay
throwaway, and untyped code that touches the database is where schema drift
hides.

This applies to `scripts/` too. The existing files there are plain `.js` for
historical reasons; new migrations should be `.ts`, run with `bun run`.

`npx tsc --noEmit` must pass before anything is committed.

## `scripts/` is database migration history

`scripts/*.js` are **not** application logic and nothing in `src/` imports them.
They are one-shot migrations, run by hand (`node scripts/<name>.js`) against the
live Postgres, each loading `.env.local` and connecting via `DATABASE_URL`.

They matter more than their "scratch script" appearance suggests: `drizzle.config.ts`
declares `out: "./drizzle"`, but **no `drizzle/` directory exists** — no generated
migrations have ever been committed. So these files are the only written record of
how the schema was built, and the only reproducible path to a fresh database.

Do not delete them as dead code. Conventions:

- Guard DDL with `IF NOT EXISTS` / `IF EXISTS` so re-running is safe.
- Seed scripts should UPSERT, not blind-INSERT.
- Adding a column means updating both the migration and the matching Drizzle
  schema in `src/lib/**/schema.ts` — they are kept in sync by hand.

Longer term this should move to real Drizzle migrations; until then, treat
`scripts/` as the source of truth for schema history.

## Schema layout

Drizzle table definitions live in domain-scoped files, not one central schema:

- `src/lib/schema.ts` — the entry point `drizzle.config.ts` points at
- `src/lib/outreach/schema.ts` — campaigns, leads, mailboxes, emails
- `src/lib/crm/schema.ts` — CRM workflow, conversations, sequences, and knowledge
- `src/lib/inbox/schema.ts` — Master Inbox and inbound-delivery diagnostics
- `src/lib/qualification/schema.ts` — domain qualification
- `src/lib/calls/schema.ts` — WhatsApp calls placed from the app (`call_sessions`)
- `src/lib/scheduler/schema.ts` — the in-process scheduler's slot claims
  (`scheduled_job_runs`, platform-wide; see `src/lib/scheduler/`)
- `src/lib/publicApi/schema.ts` - API keys for the public API (`api_keys`)
- `src/lib/auth/schema.ts` — Better Auth: users, sessions, accounts,
  verifications, organizations, members, invitations, teams, team_members

## Multi-tenancy: everything belongs to an organization

AgentSDR is multi-tenant. People sign in with Better Auth (email + password,
verified; Google when `GOOGLE_CLIENT_ID/SECRET` are set; auth mail through
Resend) and work inside an **organization** (roles owner / admin / member;
teams group people but do not scope data). Every piece of business data
belongs to exactly one organization. Read `docs/multi-tenancy/conventions.md`
before touching any query — it is the rulebook; `plan.md` beside it is the
history of the migration.

The non-negotiables:

- **Every entry point opens the organization scope once.** Routes:
  `withOrgContext(request, fn)` (or `requireCrmMutationContext` +
  `runInOrganization`). Server pages: `requirePageOrgContext()`. Workers,
  cron routes, webhooks and token links resolve the organization *from the
  data* (mailbox, Unipile account, call session, grid table, job row) and
  run each item in `runInOrganization(item.organizationId, …)`.
- **Every query on a scoped table filters by organization**: `inOrg(table)`
  in Drizzle, `organization_id = ${currentOrganizationId()}` in raw SQL,
  inherited tables through their scoped parent. Inserts set
  `organizationId` (TypeScript enforces it; the database has no default).
  Fetch-by-id of another organization's row is a 404.
- **It fails closed.** `currentOrganizationId()` outside a scope throws —
  never "default" to some organization.
- **A new table must be classified** in `src/lib/tenancy/registry.ts`
  (scoped / inherited / global) and, if scoped, created with
  `organization_id uuid NOT NULL REFERENCES organizations(id)`.
  `bun run scripts/check-organization-scope.ts --contract` fails on any
  unclassified table, missing column, invalid key or index.
- **Uniques are per organization** (email, domain, pipeline name, integration
  key, …) except provider identities (Unipile account, LinkedIn id, Gmail
  mailbox, provider message ids), which stay global because inbound webhooks
  find their organization through them.
- **Prove isolation after changing data access**: start a server on a
  disposable local copy and run `BASE_URL=… bun run --conditions=react-server
  scripts/e2e/tenancy-isolation.ts` — a second organization must see,
  change and count nothing of the first (it refuses to run against a
  non-local DATABASE_URL).

Settings that used to mean "the workspace" — platform integrations,
OpenRouter BYOK, AI and enrichment connections, the default CRM pipeline
(`ensureCrmDefaults()`), sequences, knowledge, lead categories, custom lead
fields — are per organization, created lazily on first use. Members can use
the product; owners and admins also manage integrations, AI settings,
members and teams (`requirePermission`, `src/lib/auth/permissions.ts`).
LinkedIn `JobRun`/`JobLog` are platform-wide (the cron covers every
organization), so only the **platform operator** — an owner or admin of the
initial organization (`metadata.initial`) — sees them (`isPlatformOperator`).

## Outreach merge fields

Lead columns beyond Email / First Name / Last Name / Name / Company are not
dropped on import. `src/lib/outreach/leadImport.ts` camelCases each unrecognized
CSV/XLSX header (`"Job Title"` → `jobTitle`) into the lead's `customFields` JSON,
and `src/lib/outreach/scheduler.ts` resolves any leftover `{{key}}` against it
case-insensitively. Unmatched tokens resolve to `""`, the same as a missing
first name.

## Platform integrations, not env

Unipile, Google Workspace (Gmail service account), Cloudflare R2, for
calling GoLogin and Cal.com, and Langfuse (prompts and tracing) are connected
**per organization** from the Connection page of the channel each
powers (Settings → Email / LinkedIn / WhatsApp; Langfuse on Settings → AI
provider), never from env — there is no env fallback. `src/lib/platform/` owns them: `catalog.ts` (client-safe fields),
`credentials.ts` (`getPlatformCredentials` / `requirePlatformCredentials` /
`isPlatformConnected`), `verify.ts` (one live call before saving).

Each is one row per organization in `grid_providers` keyed `platform-<key>`
(unique per organization), its credentials encrypted in
`grid_provider_credentials` like every other integration. Reads are cached
30 s per process, keyed by (organization, platform), so a change reaches
other instances within that window. Unipile webhook URLs carry `org=`; a
webhook's secret is checked against the organization the payload's account
belongs to.

A feature works only while its integration is connected: background jobs
return early, user-facing routes answer 409 (`PlatformNotConnectedError`),
and pages wrap in `RequiresPlatform`, which shows a Connect prompt. New code
that calls one of these services must do the same — never read its keys
from `process.env`.

Env keeps only what is needed before the database can be read or decrypted
(`DATABASE_URL`, `BETTER_AUTH_*`, `INTEGRATION_CREDENTIALS_KEY`), platform
infrastructure shared by every organization (`RESEND_API_KEY`,
`AUTH_EMAIL_FROM`, `GOOGLE_CLIENT_ID/SECRET` for sign-in), public URLs,
cron secrets and tuning knobs. Two deliberate exceptions:

- Prospecting's domain qualification reads `APOLLO_API_KEY` (a master key).
  It is not an integration because that section is slated for removal;
  Apollo for tables is a separate, per-table enrichment connection.
- The table HTTP column's `authEnvVar` calls an API the user names, and
  reads the secret from an env var the user names. The name must start with
  `GRID_HTTP_SECRET_` (checked when the column is saved and again when it
  runs), so a member cannot point it at `DATABASE_URL` or
  `INTEGRATION_CREDENTIALS_KEY`. The call itself refuses loopback, private,
  link-local and CGNAT addresses (resolved, redirects re-checked) unless
  `GRID_HTTP_ALLOW_PRIVATE=true`; see `src/lib/grid/runners/http.ts`.

`scripts/migrate-env-to-integrations.ts` copied an existing env setup into
the store once (verifying each; Langfuse's old `LANGFUSE_*` keys too); keep
it as the record of that move.

## The public API: API keys, not sessions

`/api/v1/*` is for other applications, not the UI (`docs/api.mdx`). It is
public in `proxy.ts`, so every route there starts with `withApiKey()`
(`src/lib/publicApi/http.ts`), which finds the organization from the key and
runs the handler in `runInOrganization`; never add one that doesn't. Keys
are `api_keys` rows (Settings, API keys; the integrations permission),
stored as a SHA-256 hash and shown once. A route reuses the app's own lib
functions rather than its own copy of the rules: leads go through
`importRowsForCampaign` (the sheet import's duplicate and suppression
checks), a stop through `stopCampaignLeads` (`sequence_completed`, not
suppression). Keep request parsing pure in `requests.ts`, with tests.

## Prompts live in Langfuse, and every AI call is traced

Langfuse is an optional platform integration **per organization**
(`langfuse`: host, public and secret key; Settings → AI provider, under
OpenRouter). An organization that connects its project gets its prompts from
there and its traces sent there; one that has not — or code running outside
an organization scope — uses the copies in code and traces nothing. Our own
is self-hosted `fuse.kandid.ai`, server v3, so the `@langfuse/*` SDK is
pinned to v5 (v6 needs a v4 server). There are no `LANGFUSE_*` keys in env.

Every prompt AgentSDR writes itself is a Langfuse prompt.
`src/lib/prompts/registry.ts` lists them by name (`<area>/<what>`, e.g.
`calls/agent-system`, `crm/draft-system`) with the copy in code, which is
what saving the integration uploads to the project (only the missing ones,
labelled production; `src/lib/observability/langfusePrompts.ts`), what
`scripts/seed-langfuse-prompts.ts --org <id>` syncs (`--update` pushes a
changed copy as a new production version, `--check` lists differences) and
what a call uses when Langfuse is unconnected or unreachable (tests always).
Templates use `{{variable}}` plus `{{#flag}}…{{/flag}}` / `{{^flag}}…{{/flag}}`
sections (`src/lib/prompts/template.ts`), so wording stays in Langfuse and
code only computes values. What organizations write (CRM and calling
instructions, knowledge, campaign instructions) stays in the database and
reaches a prompt as a variable. Never write prompt text inline in a feature:
add it to the registry and read it with `getPrompt` / `getPromptTemplate`
(`src/lib/observability/langfuse.ts`: one client per organization, 60 s
cache). Anything that caches a result built from a prompt must key it by
organization.

Every model call is wrapped in `traceGeneration` (input, prompt versions,
model, output, tokens, errors; tagged with the organization as
`userId: org:<id>`). OpenRouter's structured calls trace at
`completeStructuredWithOpenRouter`. A phone call is a Langfuse session keyed
by the call id: `call-agent-setup` (the full system prompt, at the token
mint), `call-conversation` (every turn, reply gaps, call notes, outcome —
`src/lib/calls/callTrace.ts`, when the worker posts the timeline) and its
transcription. One OpenTelemetry provider serves the process; its processor
(`src/lib/observability/langfuseRouting.ts`) routes each span to its
organization's own `LangfuseSpanProcessor` by the `agentsdr.organization_id`
it carries, and drops spans of organizations without Langfuse. Env keeps only
`LANGFUSE_TRACING=off` (stops traces for every organization — they hold lead
names and transcripts — and keeps prompts) and `LANGFUSE_TRACING_ENVIRONMENT`.
Tests and the public demo never reach Langfuse. Tracing must never break a
call: failures are logged and swallowed.

## Sending rules, not constants

Operational numbers — emails a day, send gaps, sending hours, LinkedIn
invitations and run sizes, WhatsApp warm-up and new chats a day, the default
phone country — are per-organization **Sending rules**, declared once in
`src/lib/channels/rules.ts` (client-safe: default, hard min/max, a `safe`
edge past which the page warns). Stored in `channel_settings` (one row per
organization and channel, only the keys that differ from the default), read
through `channelRules(channel)` in `rules.server.ts` (cached 30 s). Resolution
is account override → organization rule → default; the overrides are
`"LinkedInAccount"."dailyInviteLimit"`, `whatsapp_accounts.new_chats_per_day`
and the mailbox's own `daily_send_limit`. The settings form is generated from
the registry, so a new limit is a registry entry plus the engine reading it —
never a new constant or env var.

The `WHATSAPP_*` constants in `src/lib/whatsapp/contract.ts` remain only as
the defaults the extension shows (and agentsdr.ai, which copies this file) (that file must stay
import-free); `rules.test.ts` keeps them equal to the registry.

## CRM follow-ups: the reply is a person's, the follow-ups can send themselves

A reply's AI classification always applies (`replyClassificationDecision`,
`src/lib/crm/stateMachine.ts`; call transcripts keep the stricter
`classificationApplicationDecision`), and its stage's sequence drafts the
immediate reply. The rep may change the stage, then sends the reply from the
CRM — AI draft or their own. That send (or confirming the stage after it)
starts the stage's follow-ups; a reply typed outside AgentSDR does not.

A sequence with **Send follow-ups automatically** (`crm_sequences.
auto_send_follow_ups`, off by default) hands its follow-up drafts to
`src/lib/crm/autoFollowUps.ts` (`crm_drafts.auto_send_at`) instead of Action
required. The platform job `crm-auto-follow-ups` (every 5 min, production
only, `PAUSE_CRM_AUTOSEND`) sends at most one per sending account per run,
oldest first, through `sendDraft` with actor `system`, and only inside the
account's hours and its `crmFollowUpGapMinutes` Sending rule (default 30).
Email follow-ups share the mailbox's gap and daily limit with campaigns, and
the campaign scheduler yields a mailbox's turn to a waiting follow-up. A draft
the sender cannot send within 48 h, or that a person takes over ("Review
before sending"), goes to Action required like any other.

Every draft (`buildDraftPrompt`, `src/lib/crm/ai/draft.ts`) is told who it
goes out as (`sender`: the sending mailbox's display name or LinkedIn
account's name, `src/lib/crm/draftSender.ts`), `now` in the organization's
time zone, and `sequenceProgress` (step of total, our messages since the
person last wrote). Knowledge reaches it whole: there is no default budget,
because a 2,000-token cap cut the case study and dropped the documents after
it. The system prompt's general rules (write as the sender, no claims of work
not shown in the thread, no promises to send later, confirm a proposed time
instead of sending a booking link, no repeating a follow-up's ask) are not
tied to any stage; stage-specific behaviour belongs in the sequence step's
instructions or the organization's draft instructions.

## Drizzle is the only ORM

The LinkedIn subsystem was migrated from Prisma to Drizzle. Prisma is gone —
no client, CLI, or generate step remains.

The 11 LinkedIn tables it created are still live and are now described by
`src/lib/linkedin/schema.ts`, written by introspecting the database rather
than transcribing `schema.prisma` (the two had drifted — see the note at the
top of that file about enum ordering). The archived Prisma migrations and
schema live in `docs/prisma-history/` as the written record of how those
tables were built; nothing there runs.

Two table families share one database:

- **snake_case tables** — this app's originals, `src/lib/**/schema.ts`
- **quoted PascalCase, 11 tables** — the LinkedIn ones,
  `src/lib/linkedin/schema.ts`

`drizzle.config.ts` sets `tablesFilter` to an allowlist (`OWNED_TABLES`) of
the application-owned snake_case tables. The LinkedIn tables are deliberately **excluded**:
drizzle-kit will not diff or manage them, so there is no path by which
`drizzle-kit push` can alter live LinkedIn data. Without the filter,
drizzle-kit sees the unlisted tables as drift and offers to DROP them.

**When you add a snake_case table, add it to `OWNED_TABLES` too**, or
drizzle-kit will not manage it. For a LinkedIn-table change, write a one-shot
migration in `scripts/` and update `src/lib/linkedin/schema.ts` by hand — the
same convention the rest of the schema already follows.

### The lead database is the one exception

`people`, `companies`, `entity_columns` and `import_runs` are scoped by
`organization_id` and are still deliberately **absent** from `OWNED_TABLES`:
they are hand-maintained through `scripts/create-lead-tables.ts` (and the
tenancy scripts), exactly like the LinkedIn tables.

Nothing alters them at runtime any more. Custom lead fields are keys in
`people.custom` / `companies.custom` (jsonb), defined per organization in
`entity_columns` — a key is an immutable `x_<slug>`. Each organization gets
its core registry rows on first use. Rename, archive and type change are
registry-only; a type change converts the stored values and is refused if
any cannot convert; a permanent delete strips the key from that
organization's rows. A key reaches SQL only as a bound parameter, after
matching the registry (`customFieldSql`). `bun run
scripts/check-lead-column-drift.ts` checks, across all organizations, that
`custom` keys are registered and that no stray physical `x_` column exists.

### LinkedIn ids are `text`, not `uuid`

Prisma applied `@default(cuid())` client-side, so those columns are `text`
with **no database default**, holding 18k+ existing cuids. They use
`$defaultFn(createId)` (`@paralleldrive/cuid2`) rather than the
`uuid().defaultRandom()` used everywhere else, because converting them would
mean ALTER TYPE across every id and foreign key on live data. Nothing in the
codebase parses or sorts by id, so old cuid v1 and new cuid2 values coexist
fine.

## The connection pool is a hard constraint

A PostgreSQL server's `max_connections` is shared by every deployment that
points at it, and managed databases often set it low (50 is common).
`DB_POOL_MAX` (default 8) bounds this app's single pool; before the Prisma
migration the process ran two pools, which is what made the ceiling easy to
hit, and idle connections from other deployments count against it too.

When the server is full, every query in the app fails at once with:

```
remaining connection slots are reserved for roles with the SUPERUSER attribute
```

That error means capacity, not a code bug — it shows up on snake_case and
PascalCase tables alike. Before raising `DB_POOL_MAX`, check
`pg_stat_activity`, and remember a rolling deploy briefly runs two containers.

## Where the LinkedIn half lives

Merged from `linkedin-automation-next`; everything is namespaced so nothing
of AgentSDR's had to move:

- `src/app/linkedin/*` — pages, under a segment layout that supplies the
  sidebar (that app's root layout carried it; ours does not)
- `src/app/api/linkedin/*` — its API
- `src/app/api/webhooks/*` — **kept at the old path on purpose**: Unipile is
  registered against `connection-accepted` and `message-received`. Those two
  are public in `proxy.ts`; `/api/webhooks/[id]` is NOT — it returns raw
  webhook bodies to the UI, so it must stay behind auth. Never make that
  prefix public wholesale.
- `src/lib/linkedin/*`, `src/components/linkedin/*`
- `src/jobs`, `src/functions`, `src/services` — the sending engine

Two `cn()` helpers exist and are **not** interchangeable: `@/utils/cn` extends
tailwind-merge with AlignUI typography groups, `@/lib/linkedin/utils` is a
plain `twMerge(clsx())`. Pointing LinkedIn components at the former silently
changes how their classes collapse. Leave them separate.

Inbound LinkedIn replies reach the CRM by direct call, not HTTP — see
`src/lib/linkedin/messages/forwardToAgentSdr.ts`.

### `.server.ts` siblings exist for a reason

`postgres.js` cannot be bundled for the browser (Prisma's client could be).
Where a module holds both pure helpers and database calls, and a client
component imports the pure half, the queries live in a `.server.ts` sibling:

- `searchLeadLimit.ts` / `.server.ts`
- `messages/connectionList.ts` / `.server.ts`
- `inviteRetry.ts` / `.server.ts`

Adding a `db` import to one of the client-safe modules breaks the build with
`Module not found: Can't resolve 'fs'` — put the query in the `.server`
sibling instead. A `import type` from a query module is always safe; it
erases at compile time.

## Work on `main`, commit freely, push only when asked

Commit directly to `main`. Do not open a feature branch, and do not open a
PR — the branch-then-PR flow is not wanted here, and review happens on `main`
after the fact if at all.

**Do not push.** Every push to `main` triggers a deployment, so pushes are
batched: commit as you go and leave them local until the user explicitly asks
to push, then send them all at once. Committing itself needs no confirmation.

Keep `npx tsc --noEmit` passing before each commit, since nothing else gates
what lands.

## Tests run under bun, both halves of them

`npm test` is `bun test --conditions=react-server` — about 560 tests across 76 files.

The suite is split between two runners by history: roughly half the files
import `bun:test` and half import `node:test`. Bun runs both, so this is not
worth converting. `node --test` is not an option — it dies on the first
`bun:test` import with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.

`--conditions=react-server` is required, not decorative: nine files reach a
module that imports `server-only`, which throws outside that condition. The
`scripts/` entries above pass the same flag for the same reason.

## WhatsApp calling and the recorder extension

`extensions/whatsapp-recorder/` is a Chrome MV3 extension, built with
`bun run build:recorder` into its `dist/` (gitignored) and loaded unpacked.
`bun run build` also zips it (`package:recorder` → `release/`, gitignored),
and every deployment serves that zip to signed-in people at
`/downloads/call-recorder`; Settings → WhatsApp → Integrations shows the
installed version against it. From 0.14.0 its Update button opens the
extension's own Update page (`update.ts`, via the `recorder:update` bridge
request), which writes that zip into the folder Chrome loaded the extension
from — chosen once, File System Access, checked against the running
manifest — and reloads the extension.
It imports `src/lib/calls/contract.ts`, the one set of shapes the API, the
UI and the extension share — keep that file free of runtime imports.

The page reaches the extension through a content script and
`window.postMessage`, not `chrome.runtime` by id: an unpacked extension's id
differs on every machine. The origins it accepts are the built-in ones in
`extensions/whatsapp-recorder/src/origins.ts` (keep them in sync with the
manifest) plus any a person adds on the extension's Options page: those are
granted through `optional_host_permissions`, kept in chrome.storage.sync,
and get the bridge via `chrome.scripting.registerContentScripts`. A
self-hosted deployment needs no rebuild.

A call placed from AgentSDR is dialed and recorded inside web.whatsapp.com
itself: `wa-agent.ts` clicks Voice call, `wa-hook.ts` (the page's own JS
world) records from the call timer appearing to hang-up. WhatsApp Web runs
its own audio engine rather than WebRTC media tracks, so the hook taps what
WhatsApp routes to the speakers plus its microphone track — the header of
`wa-hook.ts` has the evidence. It depends on WhatsApp's English aria-labels
("Voice call", "End call"). Only calls placed from AgentSDR are recorded.

`/api/call-recorder/` is public in `proxy.ts`. The extension holds a
per-call bearer token (hash in `call_sessions.upload_token_hash`), never the
site cookie, and every route there starts with `authorizeRecorder()`.
Recordings live in Cloudflare R2 (the R2 integration) and are only ever reached
through short-lived presigned URLs.

Transcription runs through the BYOK-only OpenRouter runtime like every other
model call — never with `OPENROUTER_API_KEY` directly. The model is
chosen in Settings → AI provider (stored as `transcriptionModel` in the BYOK
settings; null means transcription is off). Gemini merges audio channels, so the stereo
recording does not give speaker labels for free there; rep/lead is inferred.

**AI voice agent (trial).** "Call with AI agent" on the Call button hands the
call to Gemini Live (`gemini-3.8-live`): wa-hook gives WhatsApp a fake
microphone that carries the model's voice and streams the lead's side out as
16 kHz PCM. The socket lives in wa-agent (`live-agent.ts`), because WhatsApp's
CSP blocks it in the page's own world. The server mints a single-use token with
the whole session locked in (`src/lib/calls/liveAgent.ts`,
`/api/call-recorder/calls/[id]/agent-token`). The lead's side reaches the model
through a filtered 16 kHz resampler (`downsample.ts`) and otherwise as Gemini
expects it — its own turn-taking defaults, no noise suppression (RNNoise was
tried and removed, 23 Oct 2026: noise was not the problem). Test option:
`AGENT_SAVE_HEARD_AUDIO=true` on the app makes the extension upload exactly
what the model heard (`calls/YYYY/MM/<id>-heard.wav`, opened at
`/api/calls/<id>/heard-audio`). Two deliberate trial exceptions:
the key comes from `GEMINI_API_KEY` in env, and the call skips OpenRouter,
which has no realtime audio API. Move the key into an organization integration
before this leaves the trial.

**Cloud calling stations.** The same agent call can run with no rep's laptop.
A *calling station* (`calling_stations`, Settings → WhatsApp → Calling numbers)
is one WhatsApp number whose WhatsApp Web lives in a browser profile:
CloakBrowser (`cloak`, the default: stealth Chromium whose profile folder on the
worker keeps the number's login and a fixed fingerprint), GoLogin (the `gologin`
platform integration) or Playwright's own Chromium (`local`, for testing). "AI agent → Call from: <station>" queues a `call_sessions` row with
`mode = 'agent_cloud'`. The call worker (`services/call-worker`, its own
package; Playwright) claims it over `/api/call-worker/*` (Bearer
`CALL_WORKER_SECRET`, public in `proxy.ts`), opens the station's browser, and
starts the call through the extension's **station mode**
(`globalThis.agentsdrStation` in `background.ts`, reached with
`serviceWorker.evaluate`). From there it is the laptop flow, except that phases
go to `/api/call-recorder/calls/:id/phase`, because no AgentSDR tab sits beside
the cloud browser; the rep's page polls them. The claim mints the call's
recorder token, and holds the station's row lock so one station runs one call.
Linking a number is a worker job too: it opens WhatsApp Web's "Log in with
phone number" and posts the code and a screenshot to the station. Shapes are in
`src/lib/calls/stationContract.ts`; logic is in `src/lib/calls/stations.ts`.
Headless Chromium must not say "HeadlessChrome": WhatsApp Web refuses to load
for it (`launchers.ts` sets a desktop user agent).
A station's browser profile must not keep `Default/Service Worker`: Chrome
caches the extension's background script there and never refreshes it for an
extension loaded from a folder at launch, so a profile ran its creation-day
background beside current page scripts (the version shown comes from the
manifest on disk, so it looked current). The worker deletes it before every
launch and leaves it out of saved profiles (`purgeServiceWorkers`).
CloakBrowser's free build mishandles `new AudioContext({ sampleRate })`: it
reports 48 kHz but renders about a quarter of real time, which garbled
WhatsApp's call audio both ways. wa-hook detects a browser that ignores a
requested rate and then makes every AudioContext at the default rate
(`fixIgnoredSampleRates`); plain Chromium is untouched.


## AI calling campaigns

A calling campaign with `run_by = 'ai'` is worked by the AI agent itself, from
cloud calling stations (`src/lib/calls/aiCampaigns/`; pages under
`/calling/campaigns/ai`). `contract.ts` there is the design: goal
(book a meeting / hand over to the team / either), a **reach** sequence of
call and WhatsApp-message steps that runs until a real conversation (a
pick-up with silence does not count), and a **chase** sequence for leads who
agreed to a meeting but have not booked. Leads are `call_campaign_contacts`
with `ai_*` columns; the rep-campaign code (`contactCallStatus.ts`,
`leadStage.ts`) leaves their stage and follow-up date to the engine.

Rep campaigns (`run_by = 'rep'`, worked by hand) are no longer listed or
created (2 Nov 2026): the Call campaigns page shows AI campaigns only, and a
rep talks to a lead with "Call now". Their data, API and pages remain for
old links; the shared calling code (`mode = 'rep'` calls from the CRM's Call
button) is unaffected.

The engine (`engine.ts`, an in-process 20 s tick, production only,
`PAUSE_AI_CALLING`) settles finished calls and messages, applies the pure
decision in `engineRules.ts` (the agent's `record_outcome` decides: booking
link + chase, hand-off to CRM Action required, a call-back at the agreed
`whenAt`, stop, Do Not Contact), and gives each idle number that a worker
holds open ONE action per tick: calling hours, a random gap, and calls a
day with a warm-up ramp are WhatsApp Sending rules (`callsPerDay`,
`callWarmupDays`, `callGapMinutes`, `callingHours`), overridable per number
(`calling_stations.calls_per_day` / `calling_hours`). Every call or message
is claimed by a `call_campaign_step_runs` row, unique per (lead, step key),
before it happens — never repeat a step; an uncertain message is failed,
not resent. A reply on any channel (`ingestInboundReplyInTransaction`) sets
open AI leads to `replied`. Cal.com (platform integration `calcom`; webhook
`/api/webhooks/calcom?org=`, public) marks a lead `booked` through the
`metadata[c]=<code>` the booking link carries — the lead's 4-character
`ai_booking_code` (unique across organizations, given when a link is first
sent), and nothing else about the person, since a link may be forwarded.
Links sent before codes carry `metadata[agentsdrContact]=<contact id>` and
still match; a booking without either falls back to the attendee's email or
phone. A yes reaches the CRM's Action required on a clock of its own, not
through the chase (so a draft campaign's leads get there too): a day after
the booking link (`BOOKING_REVIEW_MS`, kept through the chase), a day before
a booked meeting (`ai_meeting_at`, `meetingPrepAt`), a day after a
cancellation. That time is the lead's `follow_up_at` (stage `follow_up`),
which `syncCallFollowUp` mirrors onto the CRM record, and the lead list shows
it ("Action required from …").

Instructions come in layers: a short fixed part in `liveAgent.ts` (it is a
live cold phone call — one voice, short turns, wait for answers; who the
agent is; honesty that it is an AI; what the system will actually do after
the call, `afterCallFacts`, so it offers nothing else; its tools
record_outcome / wait_for_them / end_call; call notes), then the
organization's **calling instructions** (Settings → Instructions
→ Calling, `crm_settings.calling_instructions`; null = the defaults in
`src/lib/calls/callingInstructions.ts`),
the CRM Knowledge documents the campaign picks (`ai_knowledge_ids`; null =
the organization's "always include" ones, as for a call placed by hand; read
whole — a 12,000-character cap hid 59% of one organization's knowledge, and
measured latency does not change with prompt size), the campaign's
instructions and each call step's (`brief.ts`), and per call the lead's
history, the current time and the goal (`agentContext.ts`). Rehearse a
campaign's call by typing at `/api/calling/agent/rehearse`
(`AgentRehearsal`). Everything about how the agent talks and reacts belongs
in the calling instructions, not in code. "AI call" from a lead's drawer gets
a step run `now:<call id>`, settled like a call-back's (only a conversation
moves the lead; refused for Do Not Contact). Such a conversation also
reopens a closed lead (replied, handed off, not interested, unreached,
failed — never booked or stopped) when it agreed to something: a yes (link
and chase), a call-back, or a person. A call that fails after the agent
recorded its outcome keeps that outcome; it is never retried as an error.

### WhatsApp messaging through a station (no Unipile)

A calling station's number is also a `whatsapp_accounts` row with
`provider = 'station'` (`unipile_account_id = 'station:<id>'`; Unipile sync
skips it). Sending reserves the message (origin `agentsdr`) and queues a
`station_message_jobs` row; the worker claims it only while it holds the
station's lease and the station has no open call (a station does one thing
at a time), and sends it in the open WhatsApp Web through the extension's
station mode (`agentsdrStation.sendMessage`). Replies are read from WhatsApp
Web's own message store in `wa-hook.ts` (`WAWebCollections`, as
whatsapp-web.js does; `@lid` resolved to phone numbers), with a DOM fallback,
and only in station mode — a rep's own WhatsApp Web is never read. They land
through `ingestStationMessages` exactly like Unipile's (Messages tab, CRM,
sequences stop). A claimed job with no report in 2 minutes fails as
"delivery uncertain" and is never requeued. See `src/lib/whatsapp/stationMessaging.ts`
and `services/call-worker/README.md`. So the Calling pages (`src/app/calling/layout.tsx`)
are not gated on Unipile; only syncing Unipile numbers and `/whatsapp/campaigns` need it.

### A rep talking through a station ("Call now")

The AI lead drawer's "Call now" is a cloud call (`mode = 'agent_cloud'`)
with `call_sessions.remote_rep` set to `{}` (`StartCallRequest.remoteRep:
true`; `WorkerCall.remoteRep` tells the station): the rep talks from their own
AgentSDR tab, no agent. **AgentSDR relays the audio** — no WebRTC between the
two browsers: a GoLogin station's browser rewrites and strips WebRTC, so the
first build (a WebRTC link through Cloudflare TURN) never connected (29 Oct
2026), while both sides already reach AgentSDR over HTTPS.

The relay (`src/lib/calls/repRelay.server.ts`) is in-process memory, so it
holds only while the app runs as **one instance**. Per call it has two sides,
each with one long NDJSON down stream (`GET …/relay`; a newer stream replaces
the older) and audio up (mono 16-bit LE at 16 kHz) as ONE streaming POST
(`X-Relay-Stream: 1`, rotated every 45 s; HTTP/2 only in Chrome) — or, where
that does not get through, small POSTs (~40 ms each, at most 1 s; ~1 s a
round trip each, which is why the stream exists). Both senders share
`src/lib/calls/relayUplink.ts`; the relay acks a stream's first audio with
an `uplink` event, and two failed or unheard streams before any worked fall
back to POSTs for the call. Upload streams skip `src/proxy.ts` (its matcher
excludes exactly them): Next.js holds a body the proxy sees until it ends.
Audio for a side with no stream, or one more than ~0.5 s behind, is dropped,
never queued. It tells each side whether the other is there,
pings every 5 s, sends the station `hangup` when the rep hangs up (`POST
/api/calls/:id/relay/hangup`) or when the rep's stream has been gone 10 s,
and is closed by `finishCall` / `cancelCall` (else forgotten after a minute
idle). The rep's routes are cookie-authorized, the station's
(`/api/call-recorder/calls/:id/relay`) by the recorder token with CORS for
`https://web.whatsapp.com` only; while a side's stream is open, its POSTs
with the same credential skip the database (`isAuthorized`). Route rules are
in `src/lib/calls/remoteRep.ts`; contract: contract.ts, "a rep talking
through a calling station".

The tab (`src/components/calls/remoteRepCall.ts`, its bar mounted in the root
layout): mic (echo cancellation on) → AudioWorklet → 16 kHz low-passed
(`src/lib/calls/relayPcm.ts`, the extension's downsampler copied) → the uplink;
the stream → 16 kHz AudioBuffers scheduled after 100 ms of buffering,
dropped past 400 ms. Playback goes through an in-page WebRTC loopback
(`echoLoopback.ts`) because Chrome's echo canceller only treats WebRTC audio
as the far end; if the loopback does not connect in 2 s it plays directly,
and the bar asks for headphones either way. Extension 0.24.0+ (0.24.1+
streams its uplink).

### Incoming calls: the AI answers a lead who calls back

A station's extension (0.22.0+, station mode only — a rep's WhatsApp Web
never auto-answers) notices a call ringing on the number; the worker polls
`agentsdrStation.takeIncomingCalls()` about once a second on each open, idle
number and asks `POST /api/call-worker/stations/:id/incoming`
(`src/lib/calls/incoming.ts`). It answers only a known lead (a Person with
that number), not Do Not Contact, not video or group, on an active number
this worker holds and that has no open call — at any hour (calling hours
limit when we call, not when they do); anyone else rings out. Answering
creates the `call_sessions` row already claimed, with `direction =
'inbound'` (`scripts/add-call-session-direction.ts`), so the number is busy
for the claim, the engine and messaging. The call-back takes the campaign
and persona of our last AI call to that person (launched or draft — what
they heard about; else a launched campaign they are in): that campaign's
instructions, knowledge and goal (`composeAgentBrief` purpose `inbound`) and
the agent name and voice they heard. Only a launched campaign also gets a
step run `inbound:<call id>` that the engine settles like a placed call — but only a conversation moves the lead; a ring that never
connected is not a sequence attempt (nor, for a rep campaign, an unanswered
one). A lead who rang while the number was busy becomes a call-back due now
(status `callback`), so the same step resumes after it. The prompt (`agentInstructions`, `formatHistory`, the
transcription prompt) says they called us; `agentsdrStation.answerCall()`
arms the hook before pressing Accept, so the agent's microphone and the
recording work as on a placed call.

## WhatsApp messaging (Unipile)

Reps link their WhatsApp number in the Unipile dashboard; AgentSDR reads it
into `whatsapp_accounts` (`src/lib/whatsapp/accounts.ts`, "Sync from
Unipile" on /calling/accounts). Unipile account reads are split by provider:
`src/functions/syncAllAccounts.ts` takes only type LINKEDIN,
`src/services/unipile.whatsapp.ts` only WHATSAPP — keep them apart, and the
account-status webhook runs each sync in its own try/catch.

Unipile posts every messaging event, LinkedIn and WhatsApp alike, to one
webhook, `/api/webhooks/unipile-message`, which only routes by `account_type`
to the WhatsApp handler (`/api/webhooks/whatsapp-message`) or, for a LinkedIn
`message_received`, the LinkedIn one (`/api/webhooks/message-received`), and
drops the rest. Those two paths stay live and public in `proxy.ts` (exactly
those paths; the Unipile integration's webhook secret as `?secret=` or
`x-unipile-secret`) for hand-made registrations and the LinkedIn replay job.
Every delivery is logged raw in the LinkedIn webhook ledger.

Nobody registers these webhooks by hand any more: saving the Unipile
integration registers both (`connection-accepted` and `unipile-message`)
through Unipile's API (`src/lib/platform/unipileWebhooks.ts`),
each URL carrying `org=<organization id>` and each delivery the generated
secret as `x-unipile-secret`. `gateUnipileWebhook`
(`src/lib/linkedin/organizations.server.ts`) holds those URLs to both and drops
events for accounts that are not that organization's; URLs without `org` keep
the older rules. Registration replaces earlier ones (including the retired
separate `message-received` / `whatsapp-message` registrations) and is skipped on a
localhost origin. A new webhook route belongs in `UNIPILE_WEBHOOKS` and behind
the same gate.

A message's `origin` says who wrote it: `lead`, `agentsdr` (sent through
Unipile — the row is stored before the send so its echo is recognised), or
`phone` (an echo AgentSDR did not send: the rep typed it on the phone or in
WhatsApp Web). Replies reach the CRM through `src/lib/whatsapp/crmBridge.ts`
on a `whatsapp` conversation, like LinkedIn; a `phone`/`agentsdr` message
counts as the lead being answered.

Sends are guarded server-side (`contract.ts`): no new chats for 24 h after a
number is linked, 25 new chats a day per number, 10 s between sends, never
to Do Not Contact. A banned number also loses its calling.

### Message campaigns

`/whatsapp/campaigns` — cold sequences (a first message and timed
follow-ups) sent from chosen numbers; design in
`docs/whatsapp-campaigns/plan.md`, code in `src/lib/whatsapp/campaigns/`.
Tables `whatsapp_campaigns` / `_accounts` / `_leads` / `_sends`
(`scripts/create-whatsapp-campaign-tables.ts`). The sender
(`engine.ts`) is an in-process tick like the email scheduler —
production only, `PAUSE_WHATSAPP_OUTBOUND` — sending one step per number
per tick through `sendWhatsapp`, so every guardrail above applies. A
`whatsapp_campaign_sends` row per (lead, step) is the claim that keeps a
step from ever sending twice; a stale `sending` claim fails the lead as
"uncertain" rather than resending. The refusal `reason` on
`WhatsappSendRefusedError` is what the sender acts on — give any new
refusal one. A reply on any channel marks the Person's enrollments
`replied` in `ingestInboundReplyInTransaction`, beside email and LinkedIn;
the reply reaches Action required the usual way.
