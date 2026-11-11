# LinkedIn posts: write, schedule and publish from AgentSDR

Status (12 Nov 2026): all five phases built and verified locally, ready
to go live, not live. `scripts/e2e/linkedin-posts.ts` passes end to end,
139/139 checks covering Phases 1–5, on a disposable database built from
`db/schema.sql` with every migration applied (recipe: "Running the posts
e2e"); its first full run found three bugs, fixed (see "Fixes from the
first full e2e run" under Phase 5 as built). `check-organization-scope.ts
--contract` passes and drizzle-kit proposes nothing for the posts tables.
Nothing is merged, pushed or migrated in production, and no real post,
model call, R2 upload or Langfuse sync has happened: the "Go-live
checklist" below lists those steps in order, each with the user's yes.
What was built per phase: "Phase N as built".

Waiting on (Phase 1):

- [ ] **Live migration**: the user says yes, then someone runs
      `bun run scripts/create-linkedin-post-tables.ts` with production's
      `DATABASE_URL`. Until then the Posts pages fail in production
      (`linkedin_posts` does not exist). Re-runnable; creates one table.
- [ ] **A real publish**: the user picks a test LinkedIn account; publish
      one text-only post and one with an image from the composer (Publish
      now). Record whether Unipile returns `post_id` (and its shape) and the
      post's real URL, then replace the provisional `postUrlFor` in
      `src/lib/linkedin/posts/publishRules.ts` (and its test) to match.
- [ ] **Images on real R2**: upload, preview, publish with an image, and
      delete a draft with images, on an organization whose R2 integration
      is real. Locally only the "R2 not connected" path ran (409, text
      only); the R2 calls themselves are untested.
- [ ] **Generic isolation run** (`scripts/e2e/tenancy-isolation.ts`, now
      targeting the posts routes and pages): not completed. Against the dev
      server it compiles every route on first hit and was stopped after
      1 h 30 min, still in its write phase on `/api/grid/*`, before reaching
      the posts routes, with no findings printed up to then. Let it run to
      the end once (hours on the dev server; leave it overnight). Posts isolation
      itself is covered by `scripts/e2e/linkedin-posts.ts` (46/46), where
      the second organization has Unipile and an account of its own.

Waiting on (Phase 2):

- [x] **Run the e2e** (12 Nov 2026): the Phase 2 checks (409 without
      OpenRouter, isolation of accounts and Knowledge, the drafting path
      in-process with a fake completion, source and generation recorded)
      pass. `db/schema.sql` now includes the SMTP/IMAP schema, so
      `db:setup` + `db:seed:demo` work without extra steps.
- [ ] **A real generation**: with the user's yes, one generate and one
      rewrite through a real organization's OpenRouter key; check the three
      drafts keep to the rules and the trace lands in Langfuse.
- [ ] **A real read of past posts**: with the user's yes, check
      `users.getOwnProfile` returns `provider_id` and `users.getAllPosts`
      returns the account's posts on a real account (only the mock was used).
- [ ] **Prompts in existing organizations' Langfuse**: the four
      `linkedin/post-*` prompts reach a project only when its Langfuse
      integration is saved again, or by
      `scripts/seed-langfuse-prompts.ts --org <id>` (with the user's yes).
      Until then those organizations use the copies in code.

Waiting on (Phases 3, 4 and 5):

- [x] **Run the e2e** covering Phases 2–5 (12 Nov 2026, 139/139):
      `scripts/e2e/linkedin-posts.ts` has the Phase 3, 4 and 5 checks. Phase 4: themes 409 without
      OpenRouter; a seeded prospect's call read, redacted, a theme and a
      draft naming them dropped or withheld; the sealed source saved
      without ids; a tampered source refused; scheduling and publishing an
      edited post that names them refused; B reading none of A's prospects
      and unable to use A's theme. Phase 5: A's brief and voice reach the
      draft prompt in order; ideas read only public Knowledge and open as
      drafts; Learn from my posts saves nothing; B cannot read or change
      A's brief or voices, and its drafts and ideas carry none of them.
      All pass, after the fixes under "Phase 5 as built".
- [ ] **Live migrations**, with the user's yes, on production's
      `DATABASE_URL`: `bun run scripts/add-crm-post-instructions.ts` (one
      column on `crm_settings`) and
      `bun run scripts/create-linkedin-author-voices.ts` (one table). Both
      re-runnable. Until they run, the Instructions page and every post
      draft fail in production (`post_instructions` and
      `linkedin_author_voices` are read). Both were applied to a disposable
      local database built from `db/schema.sql`, where re-running them
      changed nothing and `check-organization-scope.ts --contract` passed.
      drizzle-kit proposes nothing for `linkedin_author_voices` or
      `crm_settings.post_instructions` (checked 12 Nov 2026).
- [ ] **Real AI calls**, with the user's yes, on a real organization's
      OpenRouter key: one themes call and one draft from a theme on its
      real replies and calls (check the summaries name nobody), one ideas
      call, one Learn from my posts, and one draft with a brief and a voice.
- [ ] **Prompts in Langfuse**: `linkedin/post-themes`, `-user`, `-tool`,
      `linkedin/post-ideas`, `-tool`, `linkedin/voice-summary`, `-tool`, and
      the changed `linkedin/post-system` / `linkedin/post-user`, reach an
      existing project only through
      `scripts/seed-langfuse-prompts.ts --org <id>` (`--update` for the two
      changed ones), with the user's yes.
- [ ] **One real scheduled publish** through the job's endpoint
      (`/api/linkedin/jobs/publish-posts`), on a test account.

## Go-live checklist

In this order. Each step that touches production, a real account or a
real model needs the user's yes first; nothing here has been done.

1. **Merge into `main`** (local). The branch
   `claude/linkedin-posts-golive-415a9b` contains all five phases and
   fast-forwards: `main`, `origin/main` and `upstream/main` were all at or
   behind its base (`4555474`) on 12 Nov 2026, so there are no conflicts.
   From the main checkout: `git merge --ff-only claude/linkedin-posts-golive-415a9b`,
   then `npx tsc --noEmit` and `npm test`. If `main` has moved since,
   `git merge-tree --write-tree main claude/linkedin-posts-golive-415a9b`
   shows conflicts first.
2. **Production migrations, before the code is deployed** (every page and
   draft reads these). All additive and re-runnable (`IF NOT EXISTS`), each
   prints what it made. Run from the main checkout with production's
   `DATABASE_URL` (Bun loads the checkout's `.env.local`; check it points
   where you think first):

   ```bash
   bun run scripts/add-mailbox-smtp-imap.ts
   bun run scripts/create-linkedin-post-tables.ts
   bun run scripts/add-crm-post-instructions.ts
   bun run scripts/create-linkedin-author-voices.ts
   ```

   The first belongs to the SMTP/IMAP mailboxes already on `main`; it is a
   no-op if production has it. Phase 3 has no migration of its own
   (`scheduled_at` is in `linkedin_posts`). Then
   `bun run scripts/check-organization-scope.ts --contract` against
   production (read-only). Never `drizzle-kit push` there (see "Running
   the posts e2e": it proposes unrelated drops).
3. **Where to run steps 4–8: on the deployed app** (recommended): push
   after step 2, check there, then push the `postUrlFor` fix. The
   alternative, a local `next dev` with production's env before the push,
   skips the senders (outreach, WhatsApp campaigns, AI calling and the
   scheduled jobs start only when `NODE_ENV=production`) but still starts
   the Tables enrichment worker (`startGridWorker` in
   `src/instrumentation.ts`), which would claim production's queued cells
   from that laptop. A local production build must never be started
   against the live database. Either way, use a test LinkedIn account the
   user picks.
4. **A real publish** from the composer (Publish now): one text-only post,
   one with an image. Record whether Unipile returns `post_id` and its
   shape, and the post's real URL; then fix `postUrlFor` in
   `src/lib/linkedin/posts/publishRules.ts` and its test to match, and
   commit.
5. **Images on real R2**, on an organization whose R2 integration is
   real: upload, preview, publish with an image (step 4), and delete a
   draft with images (its objects go too).
6. **Real AI calls** on a real organization's OpenRouter key: one generate
   (three drafts keep the rules), one rewrite, one "What prospects say"
   (themes name nobody) and a draft from a theme, one Suggest ideas, one
   Learn from my posts (voice-summary, and that `users.getOwnProfile` /
   `users.getAllPosts` work on a real account), one draft with a brief and
   a voice. Check the traces land in Langfuse.
7. **Langfuse prompts**, per organization that has Langfuse connected:

   ```bash
   bun run --conditions=react-server scripts/seed-langfuse-prompts.ts --org <id> --check
   bun run --conditions=react-server scripts/seed-langfuse-prompts.ts --org <id>
   ```

   The second creates the missing ones (`linkedin/post-*`,
   `linkedin/post-themes*`, `linkedin/post-ideas*`,
   `linkedin/voice-summary*`). `linkedin/post-system` and
   `linkedin/post-user` changed in Phase 4–5: if `--check` lists them as
   different, `--update` pushes the code's copy as a new production version
   (only if nobody edited them in Langfuse on purpose).
8. **One real scheduled publish** through the job's endpoint: schedule a
   post on the test account at least 5 minutes ahead, then after its time
   `curl -X POST -H "Authorization: Bearer $CRON_SECRET" <app>/api/linkedin/jobs/publish-posts`
   (`?force=1` if the in-process job already took the slot). Once
   deployed, the in-process `linkedin-publish-posts` job does the same
   every 2 minutes; `PAUSE_LINKEDIN_POSTS=true` stops it.
9. **The whole-app `tenancy-isolation.ts` sweep**, on a disposable local
   copy only (never production), left to run to the end (hours on a dev
   server; overnight): see the command in `CLAUDE.md`. Posts isolation is
   already covered by `scripts/e2e/linkedin-posts.ts`.
10. **Push** `main` (deploys): once after step 2 when checking on the
    deployed app (step 3), and again with the `postUrlFor` fix; or once,
    here, if steps 4–8 ran locally.

Decided (11 Nov 2026): posts go out on the person's own profile only
(decision 1a); any member may post from any of the organization's
accounts, with who wrote and who published recorded (2a); phases in the
order below (3). A business content brief and each person's writing voice
follow v1 as Phase 5.

## Goal

Give reps a place to write LinkedIn posts, with AI help, and publish them
from the LinkedIn accounts already connected for outreach, now or at a set
time.

AI-written LinkedIn posts are common. What other tools lack is the sales
data AgentSDR already holds: the organization's Knowledge (case studies,
objections, FAQs, product) and what prospects actually say in replies and
calls. v1 drafts posts from that, in the voice of the person posting.

A profile with recent, relevant posts also helps outbound: people look at
the sender after an invitation arrives.

Not in v1 (see "Later"): turning engagement on a post into leads,
commenting on or reacting to prospects' posts as a sequence step, and post
analytics beyond a link to the post.

## What already exists (reuse, don't rebuild)

| Need | Existing piece |
|---|---|
| Accounts to post from | `"LinkedInAccount"` (`src/lib/linkedin/schema.ts`): scoped, `status`, `name`, `headline`. `linkedinId` is the **Unipile account id** (`syncAllAccounts.ts` sets it from `acc.id`) |
| Unipile client | `getUnipileClient()` (`src/services/unipile.service.ts`): per-organization credentials, throws `PlatformNotConnectedError`. The file already calls REST directly with axios where the SDK falls short (search) |
| Publish a post | Unipile `POST /api/v1/posts` (multipart): `account_id`, `text`, `attachments` (images ≤ 6012×6012 px), `mentions`, `external_link`, `as_organization` (a company page the account manages). Answers 201 `{ object: "PostCreated", post_id: string \| null }` |
| Read the author's past posts | SDK `users.getAllPosts({ identifier, account_id, limit })`; `getPost` for one |
| Knowledge | `crm_knowledge_documents` (kinds: company, product, pricing, faq, case_study, objection, scheduling, custom; `always_include`); `listKnowledgeDocuments` / `getKnowledgeDocument` (`src/lib/crm/knowledge-service.ts`) |
| What prospects say | CRM conversations and messages (`src/lib/crm/schema.ts`), call transcripts (`call_sessions`) |
| Model calls | `completeStructuredWithOpenRouter` (`src/lib/ai/server/structuredCompletion.ts`): BYOK OpenRouter, tool-call JSON with `accept` retry, traced. `generateCrmDraft` (`src/lib/crm/ai/draft.ts`) is the pattern to copy |
| Prompts | Registry `src/lib/prompts/registry.ts` + `resolveTemplates` / `getPrompt` (Langfuse per organization, the copy in code otherwise) |
| Background job | In-process scheduler, `PLATFORM_JOBS` (`src/lib/scheduler/schedules.ts`) + `startPlatformJob` (`jobs.ts`). Production only (`config.ts`) |
| Limits | Sending rules, `linkedin` channel (`src/lib/channels/rules.ts`) |
| Images | Cloudflare R2 integration: `r2Client` (`src/lib/platform/clients.ts`); `src/lib/calls/storage.ts` shows the put / presign pattern |
| Pages | `src/app/linkedin/*` (already behind `RequiresPlatform platform="unipile"`), the nav's LinkedIn group (`src/components/nav/navConfig.ts`), `src/components/page` |

What is new: one table, the publish path and its job, the AI drafting, a
Sending rule, and the pages.

## Data model

New snake_case table `linkedin_posts`, **scoped**. Schema in
`src/lib/linkedin/posts/schema.ts`, exported from `src/lib/schema.ts`;
migration `scripts/create-linkedin-post-tables.ts`
(`CREATE TABLE IF NOT EXISTS`). Not in `src/lib/linkedin/schema.ts`: that
file mirrors the ex-Prisma tables only.

| Column | Notes |
|---|---|
| `id` | `uuid` default random |
| `organization_id` | `uuid NOT NULL REFERENCES organizations(id)` |
| `linkedin_account_id` | `text NOT NULL REFERENCES "LinkedInAccount"(id)`. In Drizzle a plain `text` without `.references()`, since drizzle-kit does not manage the LinkedIn tables (check in Phase 1 that `drizzle-kit` is quiet about it) |
| `status` | `draft \| scheduled \| publishing \| published \| failed` (CHECK) |
| `body` | `text NOT NULL`, ≤ 3,000 characters (LinkedIn's limit), checked in code and by CHECK |
| `attachments` | `jsonb NOT NULL DEFAULT '[]'`: `{ key, fileName, contentType, bytes }[]`, R2 keys |
| `source` | `jsonb`: how it was written. `{ kind: 'blank' \| 'topic' \| 'knowledge' \| 'conversations', topic?, knowledgeDocumentIds?, themeSummary? }` |
| `generation` | `jsonb` null: model, prompt names and versions of the AI draft it started from |
| `scheduled_at` | `timestamptz` null |
| `published_at` | `timestamptz` null |
| `provider_post_id` | `text` null. **Unique globally where not null** (a provider identity, like message ids) |
| `post_url` | `text` null, built from the id when Unipile returns one |
| `error` | `text` null |
| `created_by` / `published_by` | Better Auth user id (`text`); `published_by` is `system` for a scheduled post |
| `created_at` / `updated_at` | |

Indexes: `(organization_id, status, scheduled_at)` for the job and the
list; `(organization_id, linkedin_account_id, published_at)` for the daily
limit.

Checklist (CLAUDE.md): add to `OWNED_TABLES`, classify in
`src/lib/tenancy/registry.ts` (`snake("linkedin_posts")`), add the global
unique to the provider-identity list there, then run
`bun run scripts/check-organization-scope.ts --contract`.

## Phase 1: write and publish now

The plumbing, with no AI.

- **Unipile call**: `src/services/unipile.posts.ts`, `createLinkedinPost({
  accountId, text, images })`. Call `POST /api/v1/posts`
  directly with `FormData`, as the file's search call does. The SDK's
  `createPost` only types `{ object }`, and its `extra_params` only takes
  strings. Treat `post_id: null` as published, with no link.
- **Publish** (`src/lib/linkedin/posts/publish.ts`), used by the route now
  and by the job in Phase 3:
  1. In a transaction, lock the post `FOR UPDATE`; it must be `draft` or
     `scheduled`. Check the account belongs to the organization and is
     `CONNECTED`, and the account's daily limit (Sending rule below). Set
     `publishing`.
  2. Read the images from R2 and call Unipile.
  3. On success: `published`, `published_at`, `provider_post_id`,
     `post_url`. On a clear refusal (4xx): `failed` with the reason, and the
     rep can edit and try again.
  4. **Never retry on its own.** A timeout or 5xx leaves it uncertain:
     `failed` with "may have been posted — check LinkedIn before trying
     again". A second copy of a post is worse than a missing one, the same
     rule as WhatsApp sends and AI-campaign messages.
  5. A post in `publishing` for more than 5 minutes (a crashed process) is
     failed the same way by the job.
- **Sending rule** `postsPerDay` in the `linkedin` channel: posts one
  account publishes a day. Default 2, min 1, max 10, `safe: { above: 3 }`.
  Counted from `published_at` in the organization's day. A rule, not a
  constant, per CLAUDE.md.
- **Images**: upload to R2 at `linkedin-posts/<post id>/<uuid>.<ext>`
  (JPG / PNG / WebP / GIF; ≤ 6012×6012 px per Unipile; at most 4 per post in
  v1, to raise once checked against LinkedIn). Without the R2 integration
  the composer offers text only and says why. Deleting a draft deletes its
  objects.
- **Routes** (`src/app/api/linkedin/posts/…`, each in `withOrgContext`,
  409 when Unipile is not connected; parsing pure in
  `src/lib/linkedin/posts/requests.ts`, with tests):
  - `GET /` list (status filter, account filter, paged) · `POST /` create a
    draft
  - `GET/PATCH/DELETE /[id]`: edit or delete a draft or scheduled post.
    Published posts are read-only
  - `POST /[id]/images` upload · `DELETE /[id]/images/[key]`
  - `POST /[id]/publish`: publish now
- **Pages** (`src/app/linkedin/posts/…`, components in
  `src/components/linkedin/posts/`):
  - **Posts** list: Drafts · Scheduled · Published · Failed. The account
    (avatar and name), the first line, the time, a link to the post on
    LinkedIn.
  - **Composer** (`new` and `[id]`): account picker, editor with a
    3,000-character count and a preview of the lines LinkedIn shows before
    "…see more", images, Save draft, Publish now. Publish asks for
    confirmation: "This posts publicly on <name>'s LinkedIn."
  - Nav: "Posts" in the LinkedIn group, after Campaigns.
- **Audit**: a `published` post keeps `published_by`. No CRM event: a post
  is not about a lead.

Verify on a real account: one post with text, one with an image. Record
whether `post_id` comes back and what the post URL looks like (expected
`https://www.linkedin.com/feed/update/<urn>/`). Settle the URL format from
that, not from guesses.

### Phase 1 as built (11 Nov 2026)

What differs from the plan above, and why:

- **The account foreign key is declared in Drizzle** (a named
  `foreignKey(...)` to `linkedInAccounts.id`, as the tables pointing at
  `people` do), not left out. The check the plan asked for showed
  `drizzle-kit push` would otherwise drop `linkedin_posts_account_fk`; it
  manages this table's constraints even though it ignores
  `"LinkedInAccount"` itself. The organization key is named as Drizzle names
  it for the same reason. With both, drizzle-kit proposes nothing for
  `linkedin_posts`.
- **A failed post is edited back into a draft.** Publish claims only
  `draft` / `scheduled`; saving a failed post (PATCH) makes it a draft and
  clears the error, which is the "check LinkedIn, then try again" step. The
  composer does that save itself when Publish is pressed on a failed post,
  and its confirmation warns when the last attempt may have gone out.
- **Image routes take the image's uuid** (`/[id]/images/[imageId]`), not
  `<uuid>.<ext>`: `src/proxy.ts` lets any path ending in an image extension
  through untouched, demo read-only guard included. `GET` on the same path
  redirects to a presigned R2 link for the composer. Image size is checked in
  the browser (≤ 6012×6012 px) and bytes on the server (≤ 8 MB, type sniffed
  from the file's own bytes).
- **The stale `publishing` sweep** (`failStalePublishingPosts`, plus an
  across-organizations `failStalePublishingPostsEverywhere` for Phase 3's
  job) also runs whenever a post or the list is read, so a crashed publish
  does not wait for Phase 3.
- **The daily limit counts posts being published** as well as those
  published since the day began, under a per-account advisory lock, so two
  simultaneous publishes cannot both pass it.
- **The post URL is provisional** (`postUrlFor` in `publishRules.ts`): bare
  digits become `urn:li:activity:<id>`, a `urn:li:` id is used as is,
  anything else gets no link. Settle it from the real check below.

Verified locally (disposable database built from `db/schema.sql`, dev
server, a mock Unipile over TLS): `scripts/e2e/linkedin-posts.ts`, 46
checks — one Unipile call per publish and never a retry; 4xx fails with the
reason, 5xx and a dropped connection fail as "may have been posted"; a null
`post_id` publishes with no link; the third post of a day is refused before
Unipile; a stale `publishing` post is failed; published posts are
read-only; and a second organization, with Unipile connected and an
account of its own, can list, open, edit, delete, publish, upload to or
count none of the first one's posts, and cannot post on its accounts.
`check-organization-scope.ts --contract` passes; the generic
`tenancy-isolation.ts` now targets the posts routes and pages with real ids.

What still waits on a person is the "Waiting on" list under Status, at
the top of this file.

## Phase 2: AI drafts

- **Sources**, chosen in the composer:
  - **Topic**: a line or two from the rep ("why we stopped cold-calling
    before 10 am").
  - **Knowledge**: pick one or more documents (case studies, objections
    and FAQs listed first). Read whole, as the CRM drafts and calls do: no
    character cap.
  - Always added, as company context: the organization's Knowledge that is
    both `always_include` and tagged `public`. Knowledge is written for
    private replies and can hold pricing or client names that must not be
    posted, so nothing reaches a post automatically without the tag (see
    Phase 5). A document picked by hand without it shows a warning: "This
    document is not marked public."
- **The author's voice**: the account's last ~10 posts
  (`users.getAllPosts`, the account's own provider id). Cached 1 h per
  (organization, account); without them the prompt says so and asks for a
  plain, first-person voice. The author's `name` and `headline` go in too.
  Phase 5 adds the person's own stated preferences on top.
- **Output**: 3 variants, each `{ body }`, ≤ 3,000 characters, checked in
  `accept` so an off-schema answer is retried. The rep picks one, and it
  fills the editor as a draft (`source`, `generation` recorded).
- **Rewrite**: an instruction box on the current text ("shorter", "lead
  with the number", "less salesy"), giving one variant.
- **Prompts** (new `src/lib/prompts/linkedin.ts`, added to the registry):
  `linkedin/post-system`, `linkedin/post-user`, `linkedin/post-tool`,
  `linkedin/post-rewrite`. The general rules live in the system prompt:
  write as the author, first person; no claims the sources do not support;
  no invented numbers, clients or quotes; no engagement bait; hashtags at
  most 3, only if the author's past posts use them. Everything else is
  wording in Langfuse.
- **Model**: the organization's OpenRouter selection, like CRM drafts.
  Traced as `linkedin-post-draft` / `linkedin-post-rewrite` with the
  organization tag. An organization without OpenRouter sees the composer
  without the AI panel.
- Code: `src/lib/linkedin/posts/draft.ts` (`buildPostPrompt`, pure, with
  tests; `generatePostDrafts`), `voice.server.ts`, route
  `POST /api/linkedin/posts/generate` and `POST /api/linkedin/posts/rewrite`.

### Phase 2 as built (12 Nov 2026)

- Code: prompts in `src/lib/prompts/linkedin.ts`; `draft.ts` (pure
  `buildPostPrompt` / `buildRewritePrompt`, `generatePostDrafts` /
  `rewritePost`, injectable completion and templates); `voice.server.ts`;
  `ai.server.ts` (sources, the OpenRouter check, the two calls); routes
  `generate` and `rewrite`; `PostAiPanel.tsx` in the composer.
- **The model** is the organization's default OpenRouter model, as CRM
  drafts use it. "Ready" is what `getOpenRouterRuntime` checks (connected,
  BYOK-only confirmed, a default model). Errors in the call answer 502.
- **The voice**: `users.getOwnProfile` gives the account's own
  `provider_id`, then `users.getAllPosts`; reposts are left out. A failed
  read is not cached and never stops a draft; a disconnected account is not
  read. The answer says whether the voice came from past posts.
- **Hashtags are enforced in `accept`** as well as the prompt: none unless
  the author's past posts use them, at most 3. A rewrite keeps hashtags the
  rep already wrote. A rewrite must differ from the current text, and three
  drafts must differ from each other.
- **Order of checks**: the account and Knowledge must be the organization's
  own (400, the same answer as unknown) before the OpenRouter check (409),
  and both before anything is read from LinkedIn.
- **`source` and `generation` come back from the client** when the rep
  saves a used draft. They are validated (shape, our prompt names, Knowledge
  ids the organization's own); `conversations` is refused from a client, for
  Phase 4 to write server-side. `source.knowledgeDocumentIds` lists every
  document used, picked and always added. The post view now carries both.
- Tests: `draft.test.ts`, `voice.server.test.ts`, `linkedin.test.ts`
  (prompts), more in `requests.test.ts`.

## Phase 3: scheduling

- The composer gets **Schedule**: date and time in the organization's time
  zone, at least 5 minutes ahead. The post becomes `scheduled`. Editing it
  keeps it scheduled; "Unschedule" puts it back to `draft`.
- New platform job `linkedin-publish-posts`, `everyMinutes(2)`, production
  only, honours `PAUSE_LINKEDIN_POSTS` (`src/jobs/publishLinkedinPosts.ts`,
  added to `PLATFORM_JOBS` and `startPlatformJob`, with an endpoint
  `/api/linkedin/jobs/publish-posts` (Bearer `CRON_SECRET`) like the other
  LinkedIn jobs, so it can be run once by hand). Each run:
  1. Finds due posts across organizations (`status = 'scheduled' AND
     scheduled_at <= now()`), oldest first, `FOR UPDATE SKIP LOCKED`.
  2. Runs each in `runInOrganization(post.organizationId, …)` through the
     Phase 1 publish. Unipile not connected, or the account disconnected:
     it stays scheduled and the list shows why.
  3. A post more than 6 hours past its time fails ("missed its time")
     rather than going out late.
  4. A post over the account's daily limit waits for the next day, and the
     list says so.
  5. At most one post per account per run, so two posts scheduled for the
     same minute do not land together.
- The list shows the next scheduled post per account. The composer warns
  when another post is within 4 hours on the same account (a warning, not a
  rule).

## Phase 4: posts from what prospects say

The part no other tool has, and the one with real risk: prospects' words
must never end up in a public post.

- **Themes**: "What prospects say" in the composer reads the organization's
  inbound replies (email, LinkedIn, WhatsApp) and call transcripts from the
  last 30 days, newest first, up to ~50. One model call
  (`linkedin/post-themes`) groups them into 3–6 themes: an objection, a
  recurring question, a pain point, each with how often it came up. The rep
  picks one; the draft is written from the theme's summary only, never from
  the raw messages.
- **Privacy, enforced in code as well as in the prompt**:
  - The theme summaries ask for no names, companies, places, numbers or
    quotes that could identify anyone.
  - `src/lib/linkedin/posts/leakGuard.ts` (pure, tested): before a draft
    reaches the rep, check its text against the names, company names,
    email addresses and phone numbers of every person in the source set. A
    match blocks the draft and says what matched. The same check runs again
    at publish, for posts whose `source.kind` is `conversations`.
  - `source` keeps the theme summary, not the message ids, so the post row
    does not point at anyone.
- **Who sees it**: every member already sees the CRM, so no new permission.

### Phase 4 as built (12 Nov 2026)

- Code: `leakGuard.ts` (pure: `leakTerms`, `findLeaks`, `redactLeaks`,
  `describeLeaks`), `themes.ts` (pure: reply text, prompt, answer check),
  `themes.server.ts` (the source set, the call, `guardTermsFor`),
  `themeSeal.server.ts`, `leakCheck.server.ts` (the guard on a saved
  post), route `POST /api/linkedin/posts/themes`, "What prospects say" in
  `PostAiPanel.tsx`. Prompts `linkedin/post-themes`, `-user`, `-tool`; the
  system and user post prompts gained a `{{#theme}}` section.
- **The source set**: inbound `crm_conversation_messages` (email, LinkedIn
  and WhatsApp all land there) and the lead's side of transcripts of
  `call_sessions` with `transcript_status = 'done'`, in the 30 days before
  the read, newest first, 50 in all. A reply's quoted history ("> …",
  "On … wrote:", "Original Message", a later "From:") is cut; each item is
  clipped to 1,500 characters.
- **Redaction before the model**: the people's own names, companies,
  emails and phones are replaced by `[person]`, `[company]`, … in what the
  themes call reads. Not asked for in the plan; cheap, with the same terms.
- **Themes** come back 3–6 (1–3 from fewer than six messages), most raised
  first. A theme whose title or summary names someone in the source set is
  dropped, and the answer counts it ("held back").
- **What the guard matches** (decided here; see the header of
  `leakGuard.ts`): full names in any case and either order; a surname
  alone (3+ letters) only capitalised; a first name alone never (it
  rarely identifies anyone, and "Will" or "Grace" would block ordinary
  sentences); a company's name without its legal suffix (one word only
  capitalised) and its domain unless a mail provider's; emails; phones by
  their last 8 digits however grouped; LinkedIn slugs of 5+ characters;
  accents folded. Names mentioned *inside* a message (a colleague) are not
  in the source set: the prompt's rule covers those.
- **Drafts**: a draft that matches is withheld, the others shown, and the
  answer says what matched ("Zelda Quill (a name)"; a phone by its last 4
  digits). No retry: the drafting model never saw the people, so a match
  is a coincidence the rep should see.
- **"Written server-side" is a seal.** The composer saves a post (and may
  not have one yet when the drafts arrive), so the server cannot write the
  row itself. Instead each theme carries an HMAC (`INTEGRATION_CREDENTIALS_KEY`)
  over (organization, read time, title, summary); `source` keeps those
  four and the seal, never a message or person id, and saving checks the
  seal. A browser can neither invent a theme nor move its read time; a
  theme from another organization does not verify.
- **The guard at publish** re-reads the source set from the database: the
  people in the 30 days before `source.themesReadAt`, up to 1,000 items,
  a superset of the 50 the themes call read (stricter, never looser). It
  runs inside the publish claim (a refusal leaves the post as it was; the
  job fails a scheduled one with the message) and also at Schedule, so the
  rep hears of it while they are there.
- **Once from conversations, always guarded**: saving a later draft from a
  topic or Knowledge on such a post keeps its `conversations` source, since
  the text may still carry the theme draft's words. A rewrite sends the
  post's theme back, so it is guarded and keeps the source.
- Tests: `leakGuard.test.ts`, `themes.test.ts` (items, prompt, answer
  check, seals, the call with fakes, the guard on a saved post), more in
  `requests.test.ts`, `draft.test.ts`, `linkedin.test.ts`.

## Phase 5 (after v1): the business's content brief

Posts need to know two things about the business: **facts** (what it does,
for whom, results) and **how it wants to show up on LinkedIn** (audience,
themes, tone, what never to say). Facts already have a home; the second
has none yet.

- **Facts stay in Knowledge** (Settings → Knowledge). It already holds
  company, product, case study, FAQ and objection documents, used by CRM
  drafts and calls. Keeping one place for facts means a post and a reply
  never tell different stories. No second "about the business" store.
- **Public vs private** (already enforced from Phase 2): only Knowledge
  tagged `public` reaches posts automatically. Phase 5 makes the tag easy
  to use: a "Public (may be used in posts)" switch on the Knowledge editor
  that sets the tag, and a filter for it. Tags already exist on documents,
  so this needs no schema change.
- **The brief: Settings → Instructions → LinkedIn posts.** A tab beside
  Calling, with the same titled-block editor (`AiInstructionBlock[]`),
  because it is the organization's own writing about how the AI should
  write. Defaults in code (`src/lib/linkedin/posts/postInstructions.ts`,
  like `DEFAULT_CALLING_INSTRUCTIONS`), shown until someone edits them:
  - **Who we're talking to**: roles, industries, company sizes, what they
    care about.
  - **What we post about**: 3–5 content pillars.
  - **How we sound**: tone, words we use, words we never use.
  - **What we never post**: pricing, competitors by name, clients not
    cleared to name, claims not cleared.
  - **Our call to action**: what a reader should do next, if anything.
- **Storage**: `crm_settings.post_instructions` jsonb, null = the defaults,
  with the same shape CHECK as `calling_instructions`; migration
  `scripts/add-crm-post-instructions.ts`, Drizzle `src/lib/crm/schema.ts`.
  It reaches the drafting prompts as a variable (`{{postInstructions}}`),
  never as code text, per CLAUDE.md.
- **Post ideas**: with pillars written down, "Suggest ideas" on the Posts
  page proposes 5 ideas (pillar × public Knowledge × Phase 4 themes); each
  opens as a draft. One prompt, `linkedin/post-ideas`.
### Each person's writing voice

The brief is the organization's; how a person talks is their own. The CEO
and an SDR posting about the same pillar should not sound alike.

- **Per LinkedIn account, not per user.** A post goes out as the profile's
  person, and `"LinkedInAccount"` has no owner user (decision 2), so the
  voice belongs to the account.
- **Where it is edited**: Settings → LinkedIn accounts, a "Writing voice"
  dialog on each account, beside the invitation limit and working hours
  dialogs (`src/components/linkedin/AccountsClient.tsx`). The composer shows
  the chosen account's voice in one line, with an Edit link to the same
  dialog. Any member may edit it (decision 2); `updated_by` is kept.
- **What it holds**:
  - **Titled blocks** (`AiInstructionBlock[]`, the same editor as the
    brief), starting empty with hints: *How I sound* (casual or formal,
    short sentences, humour), *Format* (length, line breaks, emoji,
    hashtags, lists), *Language* (which language, US or UK spelling),
    *Phrases I use / never use*, *What I talk about*.
  - **Example posts**: up to 5 pasted posts that sound like this person
    (their own or anyone's), each ≤ 3,000 characters. Used beside the past
    posts Phase 2 reads.
  - **"Learn from my posts"**: one model call (`linkedin/voice-summary`)
    reads the account's last ~20 posts and fills the blocks as a
    suggestion. Nothing is saved until the person edits and saves it.
- **Storage**: a new scoped table `linkedin_author_voices`, one row per
  (organization, `linkedin_account_id`), unique on that pair:
  `instructions` jsonb (null = none), `example_posts` jsonb (text array),
  `updated_by`, timestamps. Migration
  `scripts/create-linkedin-author-voices.ts`, schema in
  `src/lib/linkedin/posts/schema.ts`; `OWNED_TABLES` and the tenancy
  registry as for `linkedin_posts`. A table of our own rather than a column
  on `"LinkedInAccount"`: the ex-Prisma schema stays untouched, and the
  change stays in our files.
- **How the layers combine in the prompt**, in this order: the
  organization's brief → the author's voice → the notes on this one draft.
  The brief's *What we never post* always wins. The author's voice decides
  tone and format over the brief's *How we sound*. A draft's own notes
  ("make this one formal") win over the author's defaults for that post.
  Both reach the prompt as variables (`{{authorVoice}}`, `{{postInstructions}}`).

### Phase 5 as built (12 Nov 2026)

- **Public switch**: "Public (may be used in posts)" in the Knowledge
  editor is the `public` tag itself (`withPublicTag` / `hasPublicTag` in
  `contract.ts`): turning it on adds the tag, typing `public` in Tags turns
  it on. The tag now matches in any case. A "Public" filter and a Public
  badge on the list. No schema change.
- **The brief**: `postInstructions.ts` holds the five default blocks (the
  "What we never post" one has id `never-post`) and the voice hints;
  `crm_settings.post_instructions` (`scripts/add-crm-post-instructions.ts`,
  Drizzle `src/lib/crm/schema.ts`, `db/schema.sql`) with the same shape
  CHECK as `calling_instructions`. The Instructions API and page gained a
  "LinkedIn posts" tab with defaults and Reset, exactly like Calling (the
  same editor and the same permission). `loadPostInstructions` reads it;
  a failure falls back to the defaults.
- **Layers in the prompt**: `linkedin/post-system` takes
  `{{postInstructions}}` (the brief, or the defaults), then
  `{{authorVoice}}` (the account's blocks), then says where they disagree:
  never-post always wins, the voice decides tone and format over the
  brief, the draft's own notes (topic, theme, rewrite instruction) win for
  that post. Example posts go in the context JSON as `voiceExamples`; their
  hashtags count like past posts'. "Never post wins" is a rule in the
  prompt, not a code check: what an organization lists there is free text.
- **Voices**: table `linkedin_author_voices` (scoped, in the registry and
  `OWNED_TABLES`, migration `scripts/create-linkedin-author-voices.ts`,
  `db/schema.sql`), unique per (organization, account), account FK named
  for drizzle-kit and cascading like `linkedin_posts`. Routes
  `GET/PUT /api/linkedin/posts/voices/[accountId]` (another organization's
  account is 404) and `POST …/learn`. The Writing voice dialog
  (`WritingVoiceDialog.tsx`) is in the account row's menu in
  `AccountsClient.tsx`; the composer's one line links to
  `/settings/linkedin-accounts?voice=<id>`, which opens it.
- **Learn from my posts** reads 20 of the account's own posts (reposts
  left out) and asks `linkedin/voice-summary` for five fields mapped onto
  the hinted blocks; it fills the dialog and saves nothing.
- **Ideas**: "Suggest ideas" on the Posts page (when OpenRouter is ready)
  → `POST /api/linkedin/posts/ideas`. The brief, Knowledge tagged public
  (read whole) and, unless unticked, prospects' themes, read first with
  their own call, so ideas with themes are two model calls. Sources reach
  the model by ref (K1, T1), so no seal or id leaves the server; each idea
  maps back to a `source` (a theme's sealed `conversations` source, its
  Knowledge, or its topic). Ideas are leak-guarded when themes were read.
  "Write this" creates an empty draft with that source on the chosen
  account and opens it; the AI panel starts from the draft's topic,
  Knowledge and theme.
- **Prompts as written**: each new call is a system prompt plus a tool
  description in the registry (`linkedin/post-ideas` + `-tool`,
  `linkedin/voice-summary` + `-tool`); their user messages are the context
  JSON alone, so no wording lives in code.
- `drizzle-kit push` is quiet about the new table and column, and about
  `linkedin_posts` (checked read-only on 12 Nov 2026; how in "Running the
  posts e2e").
- Tests: `brief.test.ts` (defaults, layers, voice parsing, the one line,
  the public switch, the voice summary, ideas), more in
  `aiSettings.test.ts` and `linkedin.test.ts`.

### Fixes from the first full e2e run (12 Nov 2026)

None of these could show in unit tests, which use fakes for the database
reads:

- **Themes never read calls.** The call-transcript query bound a `Date`
  inside a raw `coalesce(...)` expression; postgres.js refuses a bare
  `Date` parameter, so every themes read with a transcribed call in the
  window failed (502). It now binds `toISOString()` typed as
  `::timestamptz`, the convention elsewhere in the codebase.
- **No voice could be saved or read.** `users.id` (uuid) was joined to
  `linkedin_author_voices.updated_by` (text) with `eq()`, which TypeScript
  accepts (both are strings) and Postgres refuses (`uuid = text`). Compared
  as text, as `linkedin_posts` already did.
- **The leak guard came after the daily limit.** A post naming a prospect
  on an account at its limit was answered "already published 2 posts
  today", and a scheduled one would wait a day and then fail. The guard now
  runs before the refusals that only make a post wait (`onlyWaits` in
  `publishRules.ts`: the daily limit, a disconnected account); refusals
  about the post itself (already published, empty) still come first.
- The e2e itself now archives its own "E2E …" Knowledge, so it can run
  again on the same database.

## Decisions

1. **Who a post is published as: the person's own profile only** (a). It is
   what helps outbound, and needs nothing beyond the connected account.
   Company pages are under Later.
2. **Who may post from an account: any member**, as with campaigns (a).
   `"LinkedInAccount"` has no owner; `created_by` and `published_by` are
   recorded and shown in the list. Limiting publishing to owners and
   admins is a `requirePermission` check if it is ever wanted. A real owner
   per account (only that person publishes on their own profile) is the
   right end state, but needs an owner column on `"LinkedInAccount"`: a
   separate change.
3. **Phase order: as written** — plumbing, AI from topics and Knowledge,
   scheduling, prospects' themes, then the content brief.

## Later

- **Engagement → leads**: read comments (`getAllPostComments`) and
  reactions (Unipile's post-reactions endpoint; SDK 1.9.3 has no method for
  it) on published posts, match to People by
  LinkedIn id, and offer "add to a LinkedIn campaign".
- **Warm-up step in LinkedIn sequences**: react to or comment on a
  prospect's latest post before the invitation (`sendPostReaction`,
  `sendPostComment`), with its own Sending rules. Commenting automatically
  is the riskiest LinkedIn automation there is; start with reactions.
- **Post stats**: reactions, comments, impressions where Unipile returns
  them, read a day and a week after publishing.
- **Company pages** (`as_organization`). Needs a way to list the pages an
  account manages, which the Unipile docs do not describe; check
  `GET /api/v1/users/me` on a real account first. Adds an
  `as_organization_id` column and a page picker.
- **Documents (carousels) and video**: Unipile accepts both
  (`document_title`, `video_thumbnail`).
- **The same voice in CRM drafts** sent from that LinkedIn account. It
  would need a change to `buildDraftPrompt` (`src/lib/crm/ai/draft.ts`), a
  core upstream file, so it waits until posts have proven the voice.
- A docs page, `docs/linkedin/posts.mdx`.

## Risks

- **Account restrictions.** Unipile is not LinkedIn's official API.
  Publishing a few posts a day as a person is ordinary use, which is why
  `postsPerDay` defaults to 2. Automated comments and reactions (Later) are
  where restrictions come from.
- **Posts that read as AI** hurt the author. Voice samples, three variants
  and a human editing every post are the defence. Nothing publishes
  without a person pressing Publish or Schedule.
- **Double posting.** Handled by the claim and the never-retry rule in
  Phase 1.
- **Prospects' words in public.** Handled by Phase 4's leak guard, and by
  never passing raw messages to the drafting call.

## Touching shared files (upstream merges)

This needs a table, so it touches the shared hot spots, each with a
one-line append: `src/lib/schema.ts`, `drizzle.config.ts` (`OWNED_TABLES`),
`src/lib/tenancy/registry.ts`, `src/lib/prompts/registry.ts`,
`src/lib/scheduler/schedules.ts` and `jobs.ts`, `src/lib/channels/rules.ts`,
`src/components/nav/navConfig.ts`. Phase 5 adds a column to
`crm_settings` (an upstream table) and a tab to the Instructions page.
Everything else is new files under
`src/lib/linkedin/posts/`, `src/components/linkedin/posts/`,
`src/app/linkedin/posts/`, `src/app/api/linkedin/posts/` and
`src/services/unipile.posts.ts`. Merge `upstream/main` before each phase,
then `npx tsc --noEmit` and `npm test`.

## Running the posts e2e

What the run on 12 Nov 2026 needed, so the next one takes minutes. Every
step has a budget; past it, stop and look (server log, `lsof -i :<port>`,
`docker ps`, `pg_isready`) rather than wait.

1. **A throwaway Postgres** (≈10 s), never one in use:

   ```bash
   docker run -d --name agentsdr-e2e-db -e POSTGRES_USER=e2e -e POSTGRES_PASSWORD=e2e \
     -e POSTGRES_DB=agentsdr_e2e -p 127.0.0.1:5454:5432 postgres:16-alpine
   ```

   Gotcha: the first `pg_isready` inside the container can pass during
   init, then the server restarts; poll `pg_isready -h 127.0.0.1 -p 5454`
   from the host instead.
2. **Throwaway secrets in a file outside the repo** (never copy
   `.env.local`; Bun would load one in the working directory, and the
   worktree has none). Source it in every command:

   ```bash
   export DATABASE_URL=postgres://e2e:e2e@127.0.0.1:5454/agentsdr_e2e DATABASE_SSL=disable
   export BETTER_AUTH_SECRET=<openssl rand -hex 32> INTEGRATION_CREDENTIALS_KEY=<openssl rand -hex 32>
   export UNSUBSCRIBE_SECRET=<openssl rand -hex 32> CRON_SECRET=<openssl rand -hex 16>
   export AUTH_SIGNUP=open LANGFUSE_TRACING=off
   export BETTER_AUTH_URL=http://localhost:3217 NEXT_PUBLIC_APP_URL=http://localhost:3217
   export NODE_EXTRA_CA_CERTS=<path>/mock-cert.pem
   ```
3. **Schema, migrations, demo data** (≈1 min): `bun run db:setup`, then
   `bun run scripts/create-linkedin-post-tables.ts`,
   `bun run scripts/add-crm-post-instructions.ts`,
   `bun run scripts/create-linkedin-author-voices.ts` (all no-ops on a
   `db/schema.sql` from 12 Nov on, which has them and the SMTP/IMAP schema;
   Phase 3 has no migration), then `bun run db:seed:demo` and
   `bun run scripts/check-organization-scope.ts --contract`. Organization A
   is the seeded Northwind: `demo@example.com` / `demo-password-123`, with
   two connected LinkedIn accounts.
4. **The mock's certificate**:
   `openssl req -x509 -newkey rsa:2048 -nodes -keyout mock-key.pem -out mock-cert.pem -days 7 -subj /CN=localhost -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`.
5. **The dev server** in the background (Bash `run_in_background`, never
   the browser pane's `preview_start`, which hung): `npx next dev -p 3217`
   with the env above. Ready in seconds; poll the log for "Ready in" for at
   most 3 min. The "inferred your workspace root" warning is harmless (a
   worktree resolves `node_modules` from the main checkout).
6. **The run** (≈3–5 min; background, capped at 25 min, log tailed):

   ```bash
   MOCK_TLS_CERT=mock-cert.pem MOCK_TLS_KEY=mock-key.pem \
   INITIAL_OWNER_EMAIL=demo@example.com INITIAL_OWNER_PASSWORD=demo-password-123 \
   BASE_URL=http://localhost:3217 bun run --conditions=react-server scripts/e2e/linkedin-posts.ts
   ```

   It waits 31 s for the server's integration cache before the first
   check. It is re-runnable on the same database: it deletes A's posts at
   the start and archives its own "E2E …" Knowledge at the start and the
   end (Knowledge versions are append-only, so they cannot be deleted);
   organization B is a fresh sign-up each run.
7. **Afterwards**: stop the server; `docker rm -f agentsdr-e2e-db`.

**drizzle-kit drift, read-only.** `drizzle-kit push` has no dry run, and
`pushSchema` from `drizzle-kit/api` (0.31) drops query parameters (`there
is no parameter $1`), so it cannot introspect. What works: the CLI
(`npx drizzle-kit push --verbose --strict`) under `expect`, answering
Enter to every "truncate?" prompt (keep the data) and then "No, abort",
connected as the database owner with
`?options=-c%20default_transaction_read_only%3Don` on `DATABASE_URL`, so
DDL cannot run even if a prompt were answered wrong. A SELECT-only role
gives a false answer: `information_schema.table_constraints` hides the
constraints of tables it only has SELECT on, so every primary key, unique
and CHECK looks missing. Result on 12 Nov 2026: nothing for
`linkedin_posts`, `linkedin_author_voices` or `crm_settings`. It does
propose 393 unrelated statements across the app (dropping the seven
ex-Prisma enum types, two sequences, 19 columns on `crm_leads` and
`targeted_domains`, legacy indexes, ~136 changes to `domains`): never run
`drizzle-kit push` against production.

**`db/schema.sql`** is regenerated with `bun run db:schema:dump` from the
throwaway database after every migration is applied. The host's
`pg_dump` must be at least the server's version; with an older one, point
`PG_DUMP` at a wrapper that runs `docker exec agentsdr-e2e-db pg_dump …`
with the URL's host rewritten to `localhost:5432`.

## Checks per phase

- `npx tsc --noEmit`, `npm test` (new tests: `requests.ts`, the publish
  state rules, `buildPostPrompt`, `leakGuard.ts`, the job's due selection).
- `bun run scripts/check-organization-scope.ts --contract` after the table.
- The tenancy isolation script on a local copy after the routes
  (`scripts/e2e/tenancy-isolation.ts`): a second organization must not list,
  open, edit, publish or count another's posts.
- `scripts/e2e/linkedin-posts.ts` on a disposable database ("Running the
  posts e2e").
- A real publish from a test LinkedIn account (Phase 1) and a scheduled one
  (Phase 3), run once through the job's endpoint. Never by starting the app
  in production mode locally: that starts every other sender too, against
  the live database.
