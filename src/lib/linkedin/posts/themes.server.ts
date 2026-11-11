import "server-only";

import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { completeStructuredWithOpenRouter } from "@/lib/ai/server/structuredCompletion";
import { callSessions } from "@/lib/calls/schema";
import { crmConversationMessages, crmConversations } from "@/lib/crm/schema";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { resolveTemplates } from "@/lib/prompts/templates.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { THEME_SOURCE_LIMIT, THEME_WINDOW_DAYS, type PostTheme, type PostThemesResponse } from "./contract";
import type { ResolvedPrompt } from "@/lib/observability/langfuse";
import type { PostCompletion } from "./draft";
import { findLeaks, leakTerms, redactLeaks, type LeakPerson, type LeakTerm } from "./leakGuard";
import { sealTheme, themeSealValid } from "./themeSeal.server";
import {
  buildThemesPrompt,
  clipItem,
  leadSideOfCall,
  replyText,
  THEME_PROMPTS,
  validateThemesOutput,
  type ThemeSourceChannel,
  type ThemeSourceItem,
  type ThemeTemplates,
} from "./themes";

/**
 * Prospects' themes, in the organization in scope: the source set (inbound
 * replies on every channel and the lead's side of transcribed calls, the 30
 * days before a moment), the themes call, and the leak guard's terms for a
 * theme's source set. The source set is read again, never stored: a post
 * keeps only the time it was read (`source.themesReadAt`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rows read for the leak guard's source set. Far more than the ~50 a themes
 * call reads, so the 50 it read are always inside it: the guard checks a
 * superset, which only makes it stricter.
 */
export const GUARD_SOURCE_LIMIT = 1000;

type Reader = Pick<typeof db, "select">;

type SourceRow = ThemeSourceItem & { personId: string };

export type ThemeSourceSet = { items: SourceRow[]; people: LeakPerson[] };

function windowStart(until: Date): Date {
  return new Date(until.getTime() - THEME_WINDOW_DAYS * DAY_MS);
}

/** The replies and calls in the 30 days before `until`, newest first, at most `limit`, and the people they are from. */
export async function readThemeSourceSet({ until, limit }: { until: Date; limit: number }, reader: Reader = db): Promise<ThemeSourceSet> {
  const since = windowStart(until);
  const messages = await reader
    .select({
      personId: crmConversationMessages.personId,
      channel: crmConversationMessages.channel,
      subject: crmConversationMessages.subject,
      bodyText: crmConversationMessages.bodyText,
      at: crmConversationMessages.sentAt,
    })
    .from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .where(
      and(
        inOrg(crmConversations),
        eq(crmConversationMessages.direction, "inbound"),
        gte(crmConversationMessages.sentAt, since),
        lte(crmConversationMessages.sentAt, until),
      ),
    )
    .orderBy(desc(crmConversationMessages.sentAt))
    .limit(limit);

  const callAt = sql<Date>`coalesce(${callSessions.endedAt}, ${callSessions.startedAt}, ${callSessions.createdAt})`;
  // A raw expression has no column type to encode a Date with, and postgres.js
  // refuses a bare Date parameter: bind the instant as text, typed in SQL.
  const at = (value: Date) => sql`${value.toISOString()}::timestamptz`;
  const calls = await reader
    .select({ personId: callSessions.personId, transcript: callSessions.transcript, at: callAt.mapWith((value: string | Date) => new Date(value)) })
    .from(callSessions)
    .where(and(inOrg(callSessions), eq(callSessions.transcriptStatus, "done"), isNotNull(callSessions.transcript), gte(callAt, at(since)), lte(callAt, at(until))))
    .orderBy(desc(callAt))
    .limit(limit);

  const rows: (SourceRow & { time: number })[] = [];
  for (const message of messages) {
    const text = replyText(message.bodyText);
    rows.push({ personId: message.personId, channel: message.channel as ThemeSourceChannel, at: message.at.toISOString(), time: message.at.getTime(), text });
  }
  for (const call of calls) {
    const text = leadSideOfCall(call.transcript?.utterances ?? []);
    rows.push({ personId: call.personId, channel: "call", at: call.at.toISOString(), time: call.at.getTime(), text });
  }
  rows.sort((a, b) => b.time - a.time);
  const kept = rows.slice(0, limit);

  const personIds = [...new Set(kept.map((row) => row.personId))];
  const found = personIds.length
    ? await reader
        .select({
          firstName: people.firstName,
          lastName: people.lastName,
          fullName: people.fullName,
          email: people.email,
          phone: people.phone,
          linkedinUrl: people.linkedinUrl,
          companyName: companies.name,
          companyDomain: companies.domain,
        })
        .from(people)
        .leftJoin(companies, and(eq(companies.id, people.companyId), eq(companies.organizationId, people.organizationId)))
        .where(and(inOrg(people), inArray(people.id, personIds)))
    : [];

  return { items: kept.map((row) => ({ personId: row.personId, channel: row.channel, at: row.at, text: row.text })), people: found };
}

/** The leak guard's terms for a theme read at `readAt`: every person in the 30 days of replies and calls before it. */
export async function guardTermsFor(readAt: Date, reader: Reader = db): Promise<LeakTerm[]> {
  const { people: found } = await readThemeSourceSet({ until: readAt, limit: GUARD_SOURCE_LIMIT }, reader);
  return leakTerms(found);
}

/** Whether a theme (or a source carrying one) is one this server found for the organization in scope. */
export function verifyTheme(theme: { readAt: string; title: string; summary: string; seal: string }): boolean {
  return themeSealValid({ organizationId: currentOrganizationId(), readAt: theme.readAt, title: theme.title, summary: theme.summary }, theme.seal);
}

// ------------------------------------------------------------------ the call

const THEMES_TIMEOUT_MS = 90_000;
const THEMES_MAX_OUTPUT_TOKENS = 6_000;

export const completeThemesWithOpenRouter: PostCompletion = (input) =>
  completeStructuredWithOpenRouter({
    timeoutMs: input.timeoutMs,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    maxOutputTokens: input.maxOutputTokens,
    jsonSchema: input.jsonSchema,
    schemaName: "linkedin_post_themes",
    schemaDescription: input.toolDescription,
    accept: input.accept,
    signal: input.signal,
    trace: input.trace,
  });

export type ThemeDependencies = {
  complete?: PostCompletion;
  resolve?: (names: readonly (typeof THEME_PROMPTS)[number][]) => Promise<{ templates: ThemeTemplates; prompts: ResolvedPrompt[] }>;
  /** The source set; the database by default. */
  readSource?: (input: { until: Date; limit: number }) => Promise<ThemeSourceSet>;
  now?: () => Date;
};

/**
 * Themes from what prospects said in the last 30 days. Messages are redacted
 * (the people's own names, companies, emails and phones replaced by
 * placeholders) before the model sees them, and a theme whose title or
 * summary still names one of them is dropped. Each theme is sealed with the
 * time the messages were read.
 */
export async function findPostThemes(dependencies: ThemeDependencies = {}): Promise<PostThemesResponse> {
  const now = (dependencies.now ?? (() => new Date()))();
  // Whole seconds, so the time survives an ISO round trip unchanged.
  const readAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const source = await (dependencies.readSource ?? ((input) => readThemeSourceSet(input)))({ until: readAt, limit: THEME_SOURCE_LIMIT });
  const terms = leakTerms(source.people);
  const items = source.items
    .map((item): ThemeSourceItem => ({ channel: item.channel, at: item.at, text: clipItem(redactLeaks(item.text, terms)) }))
    .filter((item) => item.text.trim());
  if (!items.length) return { themes: [], read: 0, withheld: 0 };

  const resolve = dependencies.resolve ?? ((names) => resolveTemplates(names));
  const { templates, prompts } = await resolve(THEME_PROMPTS);
  const prompt = buildThemesPrompt(items, templates);
  const completion = await (dependencies.complete ?? completeThemesWithOpenRouter)({
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    toolDescription: prompt.toolDescription,
    jsonSchema: prompt.jsonSchema,
    accept: (text) => {
      validateThemesOutput(text, prompt.rules);
    },
    timeoutMs: THEMES_TIMEOUT_MS,
    maxOutputTokens: THEMES_MAX_OUTPUT_TOKENS,
    trace: { name: "linkedin-post-themes", prompts, metadata: { messages: items.length } },
  });

  const found = validateThemesOutput(completion.text, prompt.rules);
  const organizationId = currentOrganizationId();
  const themes: PostTheme[] = [];
  let withheld = 0;
  for (const theme of found) {
    if (findLeaks(`${theme.title}\n${theme.summary}`, terms).length) {
      withheld += 1;
      continue;
    }
    const fields = { organizationId, readAt: readAt.toISOString(), title: theme.title, summary: theme.summary };
    themes.push({ ...theme, readAt: fields.readAt, seal: sealTheme(fields) });
  }
  return { themes, read: items.length, withheld };
}
