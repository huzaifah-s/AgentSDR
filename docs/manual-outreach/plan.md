# Manual outreach: reach one person, and log what happened

Status: Phases 1–3 built (11 Nov 2026: 8766c83, 346eadf, 7baf29d, b9c2ec9);
Phase 4 not started. Builds on the hand-entered People and Companies on the
Leads page (commits 8e26b3c, 7d9c1c5, 57eb5f0).

Decided: **(a)**, a person enters the CRM at the first manual touch. One-off
emails are outbound messages on the record's email conversation (keyed by
the Gmail thread), and `replyBridge.ts` treats a sender who already has a
CRM conversation on that thread as a known recipient: before, a reply from
anyone outside an email campaign reached only the Master Inbox.

## Goal

Work a contact one at a time, without a campaign and without Unipile:

1. **Reach them from the app**: call, send a WhatsApp message, or send an
   email to one person, straight from the Leads list.
2. **Log what happened outside the app**: "called from my phone", "WhatsApped
   from my own number", "met at the event", "they replied: interested, call
   back Thursday". These updates are kept on the person and show up in the CRM.

## What already exists (reuse, don't rebuild)

| Need | Existing piece | Needs Unipile? |
|---|---|---|
| Call one person | `CallButton` (`src/components/calls/CallButton.tsx`): takes `personId` + `phone`; `crmRecordId` is optional. Rep calls through their own WhatsApp Web + recorder extension; AI-agent calls through a calling station | No |
| WhatsApp one person | `PersonWhatsappPanel` → `POST /api/whatsapp/send` → `sendWhatsapp`; sends through a station number (`provider = 'station'`) or a Unipile number, with every guardrail (24 h warm-up, new chats a day, 10 s gap, Do Not Contact) | No (station) |
| Email one person | `sendEmail` (`src/lib/outreach/gmail.ts`) through a connected mailbox; the CRM's `sendDraft` already uses it | No (Google Workspace) |
| Record what the rep sent outside a draft | `src/lib/crm/manualOutbound.ts` (records an outbound message on a CRM conversation and settles the record) | No |
| Activity history | `crm_events` (`eventType` is free text, `crmRecordId` is optional, `meta` is jsonb); the record page's Activity drawer lists them | No |
| Replies → CRM | email by address (`replyBridge.ts`), WhatsApp by phone, LinkedIn by profile; the first reply creates the CRM record | Email/WhatsApp-station: No |

Two upstream rules to keep: a CRM record begins at a **reply or a call
conversation** (`getOrCreateCrmRecordForInbound` / `ForCall`), and a record
with no conversation does not take inbound-only operations (stage moves,
sequences). See `src/lib/crm/records.ts`.

## Phase 1: a person drawer on the Leads page

Clicking a person who has no CRM record opens a side drawer. People with a
record still open the CRM record, as today. The row menu gets the same
actions.

The drawer shows details and company (Edit person is already built), an
**Activity** list (logged updates, calls, messages), and these actions:

- **Call**: `CallButton` with `personId` + `phone`. Nothing new in the
  backend. A call that reaches a conversation creates the CRM record (existing
  rule).
- **WhatsApp**: `PersonWhatsappPanel`. Nothing new in the backend.
- **Send email**: see Phase 2.
- **Log an update**: see Phase 3.

Files: new `src/components/leads/PersonDrawer.tsx`; small edits to
`PeopleTable.tsx` (row click and menu) and `LeadsClient.tsx`.

## Phase 2: send one email

A composer in the drawer: mailbox (connected Google Workspace mailboxes),
subject and body. A new route, `POST /api/leads/people/[id]/email`, would:

- Refuse Do Not Contact and suppressed addresses (same checks as campaigns),
  and respect the mailbox's daily limit and sending gap (Sending rules), so a
  one-off email cannot push a mailbox past what campaigns are held to.
- Send through `sendEmail`. Return 409 `PlatformNotConnectedError` when Google
  is not connected.
- Record the sent message so the reply's thread has it (see decision 1).

Files: new route plus `src/lib/leads/manualEmail.ts`; it reuses outreach's
suppression and mailbox-limit helpers.

## Phase 3: log an update

A form in the drawer, also reachable from the CRM record:

- **What**: Call · WhatsApp (my phone) · Email (my own inbox) · LinkedIn ·
  Meeting · Note
- **Direction**: We reached out / They replied
- **When**: defaults to now
- **Summary**: free text
- **Next follow-up**: optional date

Stored as a `crm_events` row: `eventType = 'activity.logged'`,
`actorType = 'human'`, `actorRef` = the user, and
`meta = { kind, direction, summary, occurredAt, followUpAt }`. Its
`crmRecordId` is set when the person has a record. This needs **no schema
change**: no new table, no change to the CRM channel set or its CHECK
constraints.

Shown in the drawer's Activity list and the CRM record's Activity drawer (add
`activity.logged` to `eventLabels`, and show `meta.summary` in `EventRow`).

**Follow-up date**: if set, the person shows in Action required on that date.
That needs a record (see decision 1). For a record without a conversation,
follow the call path, `src/lib/calls/leadStage.ts`, which already sets a stage
and follow-up on call-only records. Confirm the details there before building.

## Phase 4 (later, optional)

- Feed logged updates into the AI draft's context (`src/lib/crm/context.ts`),
  so a draft knows "they asked to be called back Thursday". This touches a
  core upstream file, so do it last and keep it small.
- An "Activity" filter on the Leads list (contacted, not yet contacted).

## Decisions needed

1. **When does a manual contact enter the CRM pipeline?**
   - **(a) Recommended: at the first logged update or one-off email, like a
     call.** It appears in the Pipeline right away and can carry a follow-up
     date. Needs one new helper beside `getOrCreateCrmRecordForCall`
     (`…ForManualActivity`, which emits `record.created`), plus the
     call-only-record limits above.
   - **(b) Upstream's rule as it is: only at a reply or a call conversation.**
     Logged updates are kept on the person (events with no record) and attach
     to the record when it appears. Nothing in `records.ts` changes, but there
     are no follow-up dates before a reply.
2. **One-off email history (Phase 2)**: with (a), record it as an outbound
   message on an email conversation (`upsertConversationInTransaction` +
   `insertConversationMessageInTransaction`, as `manualOutbound.ts` does).
   With (b), keep it as an event and show it in the thread when the reply
   arrives.

## Staying mergeable with upstream (Kandid-ai/AgentSDR)

Current state: `upstream/main` was fetched on 11 Nov 2026. This branch is 0
commits behind it, and a dry-run merge (`git merge-tree`) is clean. Our three
commits touch 8 upstream files for about 130 lines; the rest is new files.

Rules for this work:

- **Prefer new files.** Edits to upstream files stay small and local: a prop,
  a menu item, an exported helper.
- **No schema changes unless unavoidable.** Use `crm_events` for logged
  updates. A new table would touch shared hot spots: `scripts/`, the schema
  files, `tenancy/registry.ts`, `OWNED_TABLES`. If one is ever needed, follow
  CLAUDE.md's checklist and keep each edit an append.
- **Don't extend the CRM channel set** (`CRM_CHANNELS`, the CHECK
  constraints). The switches over it are exhaustive on purpose, so a new
  channel fails the build until every one is updated, and upstream changes
  those switches often.
- **Merge upstream often**, before starting each phase:
  `git fetch upstream && git merge upstream/main`, then `npx tsc --noEmit` and
  `npm test`.
- **Consider sending generic pieces upstream as PRs** (Add/Edit person, Add
  company). Upstream merges outside PRs (#5, #8, #9), and anything accepted
  there stops being ours to merge.
