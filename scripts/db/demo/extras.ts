/**
 * The smaller features, each with enough in it to show:
 *
 * - An SMTP + IMAP mailbox (a provider other than Google Workspace), with its
 *   login stored the way the app stores it (password encrypted).
 * - API keys for the public API: two in use, one revoked.
 * - CompanyEnrich connected for Tables (placeholder key).
 * - "Send follow-ups automatically" on one CRM sequence, with its waiting
 *   follow-up drafts queued to send themselves.
 * - Manual outreach from the lead database: people and companies added by
 *   hand, one-off emails sent from a person's drawer, and logged updates
 *   (calls from a phone, meetings, notes), some with a follow-up date.
 *
 * Manual touches go through the app's own functions (upsertManualPerson,
 * recordSentManualEmail, logManualActivity); the history they stamp "now"
 * is moved to when it happened. Nothing sends.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviderCredentials, gridProviders } from "@/lib/grid/schema";
import { encryptCredentialText } from "@/lib/integrations/credential-crypto";
import { encryptIntegrationCredentials } from "@/lib/integrations/credentials";
import { people } from "@/lib/leads/schema";
import { upsertManualPerson } from "@/lib/leads/manualImport";
import { recordSentManualEmail } from "@/lib/leads/manualEmail";
import { logManualActivity, type LoggedActivityKind } from "@/lib/leads/manualTouch";
import { mailboxCredentials, mailboxes } from "@/lib/outreach/schema";
import { apiKeys } from "@/lib/publicApi/schema";
import { createApiKeySecret } from "@/lib/publicApi/token";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { TEAM, type TeamKey } from "./content";
import { DAY, HOUR, MINUTE, count, createRng, daysAgo, workTime, type DemoContext, type DemoPerson } from "./context";

export async function seedExtras(shared: DemoContext): Promise<void> {
  const ctx: DemoContext = { ...shared, rand: createRng(73) };
  const { rand, now } = ctx;
  const org = currentOrganizationId();

  const marker = async () => (await db.execute<{ t: string }>(sql`select clock_timestamp()::text as t`))[0]!.t;
  /** crm_events are append-only; put what a call just wrote at the time it happened. */
  const restamp = async (personId: string, since: string, at: Date) => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`
        with v as (
          select id, row_number() over (order by created_at, id) as rn from crm_events
           where organization_id = ${org} and person_id = ${personId}::uuid and created_at > ${since}::timestamptz)
        update crm_events e set created_at = ${at.toISOString()}::timestamptz + (v.rn - 1) * interval '1 second'
          from v where e.id = v.id`);
      await tx.execute(sql`
        update crm_records set created_at = ${at.toISOString()}::timestamptz
         where organization_id = ${org} and person_id = ${personId}::uuid and created_at > ${since}::timestamptz`);
    });
  };

  // ------------------------------------------------------------ SMTP + IMAP mailbox
  const imapCreated = daysAgo(ctx, 6);
  const [imap] = await db
    .insert(mailboxes)
    .values({
      organizationId: org,
      emailAddress: "events@northwind-mail.example",
      displayName: "Northwind Events",
      status: "connected",
      provider: "imap",
      lastTestedAt: new Date(now.getTime() - rand.int(2, 20) * HOUR),
      imapCursor: { uidValidity: "1730419200", lastUid: 2814 },
      dailySendLimit: 25,
      todayEmailsSent: 0,
      nextEmailTime: new Date(now.getTime() + rand.int(5, 30) * MINUTE),
      signatureHtml: `${TEAM.priya.name}\nEvents, Northwind`,
      workingHours: {
        timezone: "America/Chicago",
        days: {
          monday: { enabled: true, from: "09:00", to: "17:00" },
          tuesday: { enabled: true, from: "09:00", to: "17:00" },
          wednesday: { enabled: true, from: "09:00", to: "17:00" },
          thursday: { enabled: true, from: "09:00", to: "17:00" },
          friday: { enabled: true, from: "09:00", to: "15:00" },
          saturday: { enabled: false, from: "09:00", to: "17:00" },
          sunday: { enabled: false, from: "09:00", to: "17:00" },
        },
      },
      createdAt: imapCreated,
      updatedAt: imapCreated,
    })
    .returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: imap!.id,
    settings: {
      smtpHost: "smtp.northwind-mail.example",
      smtpPort: 465,
      smtpSecurity: "tls",
      imapHost: "imap.northwind-mail.example",
      imapPort: 993,
      imapSecurity: "tls",
      username: "events@northwind-mail.example",
      sentFolder: "Sent",
    },
    encryptedSecret: encryptCredentialText(JSON.stringify({ password: "demo-app-password" })),
    createdAt: imapCreated,
    updatedAt: imapCreated,
  });
  count(ctx, "SMTP + IMAP mailboxes", 1);

  // ------------------------------------------------------------ API keys
  const keys: { name: string; by: TeamKey; createdDays: number; usedMinutes: number | null; revokedDays?: number }[] = [
    { name: "HubSpot workflow: new demo requests", by: "alex", createdDays: 9, usedMinutes: 95 },
    { name: "Zapier: webinar sign-ups", by: "priya", createdDays: 5, usedMinutes: 3 * 24 * 60 + 40 },
    { name: "Test key (Postman)", by: "alex", createdDays: 10, usedMinutes: 9 * 24 * 60, revokedDays: 8 },
  ];
  for (const k of keys) {
    const secret = createApiKeySecret();
    await db.insert(apiKeys).values({
      organizationId: org,
      name: k.name,
      keyPrefix: secret.prefix,
      keyHash: secret.hash,
      createdBy: ctx.users[k.by].id,
      createdAt: daysAgo(ctx, k.createdDays),
      lastUsedAt: k.usedMinutes === null ? null : new Date(now.getTime() - k.usedMinutes * MINUTE),
      revokedAt: k.revokedDays === undefined ? null : daysAgo(ctx, k.revokedDays),
    });
  }
  count(ctx, "API keys", keys.length);

  // ------------------------------------------------------------ CompanyEnrich for Tables
  const enrichAt = daysAgo(ctx, 8);
  const [enrich] = await db
    .insert(gridProviders)
    .values({
      organizationId: org,
      key: `companyenrich-${randomUUID()}`,
      name: "Northwind CompanyEnrich",
      config: { integrationKey: "companyenrich", verification: { status: "verified", verifiedAt: enrichAt.toISOString() } },
      enabled: true,
      createdAt: enrichAt,
      updatedAt: enrichAt,
    })
    .returning({ id: gridProviders.id });
  await db.insert(gridProviderCredentials).values({ providerId: enrich!.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: "demo-companyenrich-key" }) });
  count(ctx, "integration accounts for Tables (CompanyEnrich)", 1);

  // ------------------------------------------------------------ automatic follow-ups
  const [auto] = await db.execute<{ id: string }>(sql`
    update crm_sequences set auto_send_follow_ups = true
     where organization_id = ${org} and name = 'Send the overview' returning id`);
  // Its follow-ups still to come are drafted and sent without review once due.
  if (auto) count(ctx, "CRM sequences sending follow-ups automatically", 1);

  // ------------------------------------------------------------ manual outreach
  const added: { input: Parameters<typeof upsertManualPerson>[0]; days: number }[] = [
    { days: 6, input: { firstName: "Marta", lastName: "Kowalczyk", email: "marta.kowalczyk@lumenfreight.example", title: "VP Sales", companyName: "Lumen Freight", companyDomain: "lumenfreight.example", phone: "+13125550177", notes: "Met at the Chicago RevOps meetup; asked for the pilot details." } },
    { days: 6, input: { firstName: "Tomás", lastName: "Arce", email: "tomas.arce@lumenfreight.example", title: "Sales Operations Manager", companyName: "Lumen Freight", companyDomain: "lumenfreight.example" } },
    { days: 3, input: { firstName: "Hannah", lastName: "Whitlock", email: "hannah@quillandcompass.example", title: "Founder", companyName: "Quill & Compass", companyDomain: "quillandcompass.example", linkedinUrl: "https://www.linkedin.com/in/hannah-whitlock-qc", notes: "Referral from Brightloop's VP of Sales." } },
    { days: 1, input: { firstName: "Dev", lastName: "Raghunathan", email: "dev.r@quillandcompass.example", title: "Head of Growth", companyName: "Quill & Compass", companyDomain: "quillandcompass.example" } },
  ];
  const manualIds: string[] = [];
  for (const a of added) {
    const { personId } = await upsertManualPerson(a.input);
    const at = workTime(ctx, a.days + 1);
    await db.update(people).set({ createdAt: at, updatedAt: at }).where(and(inOrg(people), eq(people.id, personId)));
    manualIds.push(personId);
  }
  await db.execute(sql`
    update companies c set created_at = p.first_at, updated_at = p.first_at
      from (select company_id, min(created_at) as first_at from people where organization_id = ${org} and source = 'manual-people-import' group by company_id) p
     where c.organization_id = ${org} and c.id = p.company_id`);
  count(ctx, "people added by hand", added.length);

  // One-off emails from a person's drawer.
  const alexMailbox = { emailAddress: "alex@northwind.example", displayName: TEAM.alex.name };
  const emails: { personId: string; mailbox: typeof alexMailbox; by: TeamKey; days: number; subject: string; body: string }[] = [
    {
      personId: manualIds[0]!, mailbox: alexMailbox, by: "alex", days: 5,
      subject: "Pilot details, as promised",
      body: "Hi Marta,\n\nGood to meet you at the meetup on Tuesday. As promised, the pilot is two seats for 14 days on one campaign, free, and we set it up with you.\n\nWould Thursday at 11 or Friday at 2 work for a 20-minute kickoff?\n\nAlex",
    },
    {
      personId: manualIds[2]!, mailbox: alexMailbox, by: "alex", days: 2,
      subject: "Intro via Brightloop",
      body: "Hi Hannah,\n\nMaya at Brightloop suggested we talk. They use Signal to pick which accounts their SDRs work each week, and she thought it might fit how you're building outbound at Quill & Compass.\n\nOpen to a short call next week?\n\nAlex",
    },
  ];
  for (const e of emails) {
    const [person] = await db.select({ email: people.email }).from(people).where(and(inOrg(people), eq(people.id, e.personId))).limit(1);
    if (!person?.email) continue;
    const sentAt = workTime(ctx, e.days);
    const since = await marker();
    const id = randomUUID().replaceAll("-", "").slice(0, 16);
    await recordSentManualEmail({
      personId: e.personId,
      mailbox: e.mailbox,
      to: person.email,
      subject: e.subject,
      body: e.body,
      sent: { id, messageId: `<${id}@northwind.example>`, threadId: id },
      sentAt,
      actorRef: TEAM[e.by].email,
    });
    await restamp(e.personId, since, sentAt);
  }
  count(ctx, "one-off emails from the lead drawer", emails.length);

  // Logged updates: what reps did outside BraintreeSDR.
  const pick = (pool: DemoPerson[], n: number) => rand.shuffle(pool.filter((p) => !p.phone)).slice(0, n);
  const others = pick(ctx.pools.unassigned, 3);
  const updates: { personId: string; by: TeamKey; days: number; kind: LoggedActivityKind; direction: "outbound" | "inbound"; summary: string; followUpDays?: number }[] = [
    { personId: manualIds[0]!, by: "alex", days: 4, kind: "call", direction: "inbound", summary: "Marta called back about the pilot. Wants Tomás (sales ops) on the kickoff; their CRM is HubSpot. Kickoff pencilled for next week.", followUpDays: 3 },
    { personId: manualIds[1]!, by: "priya", days: 3, kind: "email", direction: "outbound", summary: "Sent Tomás the HubSpot sync overview from my own inbox, as Marta asked." },
    { personId: manualIds[2]!, by: "alex", days: 1, kind: "linkedin", direction: "inbound", summary: "Hannah replied on LinkedIn: interested, but busy until the end of the month. Asked to reconnect then.", followUpDays: 12 },
    { personId: manualIds[3]!, by: "sam", days: 0, kind: "note", direction: "outbound", summary: "Dev owns the outbound budget at Quill & Compass, per Hannah. Keep him copied." },
    ...others.map((p, i) => ({
      personId: p.id,
      by: (["jordan", "lena", "sam"] as TeamKey[])[i]!,
      days: [8, 5, 2][i]!,
      kind: (["meeting", "whatsapp", "call"] as LoggedActivityKind[])[i]!,
      direction: "outbound" as const,
      summary: [
        `Coffee with ${p.firstName} at a Boston sales meetup. ${p.company.name} is reviewing tools in Q1; send the case study before then.`,
        `Messaged ${p.firstName} on WhatsApp from my phone with the webinar replay link.`,
        `Called ${p.firstName} from my mobile, left a short voicemail about the account-scoring webinar.`,
      ][i]!,
      followUpDays: i === 0 ? 6 : undefined,
    })),
  ];
  for (const u of updates) {
    const occurredAt = workTime(ctx, u.days);
    const since = await marker();
    await logManualActivity({
      personId: u.personId,
      update: {
        kind: u.kind,
        direction: u.direction,
        occurredAt,
        summary: u.summary,
        followUpAt: u.followUpDays ? new Date(occurredAt.getTime() + u.followUpDays * DAY) : null,
      },
      actorRef: TEAM[u.by].email,
    });
    await restamp(u.personId, since, new Date(occurredAt.getTime() + 2 * MINUTE));
  }
  count(ctx, "logged updates (calls, meetings, notes)", updates.length);
}
