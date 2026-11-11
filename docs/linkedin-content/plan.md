# LinkedIn posts: write, schedule and publish from AgentSDR

Status: planned (11 Nov 2026), nothing built.

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

## Checks per phase

- `npx tsc --noEmit`, `npm test` (new tests: `requests.ts`, the publish
  state rules, `buildPostPrompt`, `leakGuard.ts`, the job's due selection).
- `bun run scripts/check-organization-scope.ts --contract` after the table.
- The tenancy isolation script on a local copy after the routes
  (`scripts/e2e/tenancy-isolation.ts`): a second organization must not list,
  open, edit, publish or count another's posts.
- A real publish from a test LinkedIn account (Phase 1) and a scheduled one
  (Phase 3), run once through the job's endpoint. Never by starting the app
  in production mode locally: that starts every other sender too, against
  the live database.
