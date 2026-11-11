import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { completeStructuredWithOpenRouter } from "@/lib/ai/server/structuredCompletion";
import { users } from "@/lib/auth/schema";
import { formatAiInstructions, type AiInstructionBlock } from "@/lib/crm/ai/instructions";
import { db } from "@/lib/db";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import type { ResolvedPrompt } from "@/lib/observability/langfuse";
import { fillPrompt } from "@/lib/prompts/template";
import { codeTemplates, type PromptTemplates } from "@/lib/prompts/templates";
import { resolveTemplates } from "@/lib/prompts/templates.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { VOICE_LEARN_POSTS, type AuthorVoiceView } from "./contract";
import type { PostCompletion } from "./draft";
import { PostApiError } from "./posts.server";
import { MAX_VOICE_EXAMPLES, VOICE_BLOCK_HINTS } from "./postInstructions";
import type { AuthorVoiceInput } from "./requests";
import { linkedinAuthorVoices } from "./schema";
import { readPastPostsFromUnipile, type PastPostsReader } from "./voice.server";

/**
 * Each person's writing voice (Phase 5), in the organization in scope: one
 * row per LinkedIn account (linkedin_author_voices), edited in the Writing
 * voice dialog on Settings → LinkedIn accounts by any member, and "Learn from
 * my posts", which suggests the blocks from the account's recent posts
 * without saving anything. Another organization's account is "not found".
 */

async function accountInOrg(linkedinAccountId: string) {
  const [account] = await db
    .select({ id: linkedInAccounts.id, linkedinId: linkedInAccounts.linkedinId, name: linkedInAccounts.name, headline: linkedInAccounts.headline, status: linkedInAccounts.status })
    .from(linkedInAccounts)
    .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, linkedinAccountId)));
  if (!account) throw new PostApiError(404, "LinkedIn account not found");
  return account;
}

function emptyView(linkedinAccountId: string): AuthorVoiceView {
  return { linkedinAccountId, instructions: [], examplePosts: [], updatedBy: null, updatedAt: null };
}

/** Every account's voice in the organization, by account id (for the composer's one line). */
export async function listAuthorVoices(): Promise<Record<string, AuthorVoiceView>> {
  const rows = await db
    .select({ voice: linkedinAuthorVoices })
    .from(linkedinAuthorVoices)
    .where(inOrg(linkedinAuthorVoices));
  return Object.fromEntries(
    rows.map(({ voice }) => [
      voice.linkedinAccountId,
      { linkedinAccountId: voice.linkedinAccountId, instructions: voice.instructions ?? [], examplePosts: voice.examplePosts, updatedBy: null, updatedAt: voice.updatedAt.toISOString() },
    ]),
  );
}

export async function getAuthorVoice(linkedinAccountId: string): Promise<AuthorVoiceView> {
  await accountInOrg(linkedinAccountId);
  const [row] = await db
    .select({ voice: linkedinAuthorVoices, updatedByName: users.name })
    .from(linkedinAuthorVoices)
    // users.id is a uuid, updated_by text (as on linkedin_posts): compare as text.
    .leftJoin(users, sql`${users.id}::text = ${linkedinAuthorVoices.updatedBy}`)
    .where(and(inOrg(linkedinAuthorVoices), eq(linkedinAuthorVoices.linkedinAccountId, linkedinAccountId)));
  if (!row) return emptyView(linkedinAccountId);
  return {
    linkedinAccountId,
    instructions: row.voice.instructions ?? [],
    examplePosts: row.voice.examplePosts,
    updatedBy: row.voice.updatedBy ? { id: row.voice.updatedBy, name: row.updatedByName ?? null } : null,
    updatedAt: row.voice.updatedAt.toISOString(),
  };
}

export async function saveAuthorVoice(linkedinAccountId: string, input: AuthorVoiceInput, userId: string): Promise<AuthorVoiceView> {
  await accountInOrg(linkedinAccountId);
  const now = new Date();
  await db
    .insert(linkedinAuthorVoices)
    .values({
      organizationId: currentOrganizationId(),
      linkedinAccountId,
      instructions: input.instructions,
      examplePosts: input.examplePosts.slice(0, MAX_VOICE_EXAMPLES),
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: [linkedinAuthorVoices.organizationId, linkedinAuthorVoices.linkedinAccountId],
      set: { instructions: input.instructions, examplePosts: input.examplePosts.slice(0, MAX_VOICE_EXAMPLES), updatedBy: userId, updatedAt: now },
    });
  return getAuthorVoice(linkedinAccountId);
}

/** What a draft reads of the account's voice: the blocks rendered, and the example posts. Null when none is written. */
export async function voiceForDraft(linkedinAccountId: string): Promise<{ instructions: string | null; examplePosts: string[] } | null> {
  const [row] = await db
    .select({ instructions: linkedinAuthorVoices.instructions, examplePosts: linkedinAuthorVoices.examplePosts })
    .from(linkedinAuthorVoices)
    .where(and(inOrg(linkedinAuthorVoices), eq(linkedinAuthorVoices.linkedinAccountId, linkedinAccountId)));
  if (!row) return null;
  const instructions = formatAiInstructions(row.instructions ?? []);
  if (!instructions && !row.examplePosts.length) return null;
  return { instructions, examplePosts: row.examplePosts };
}

// --------------------------------------------------------- Learn from my posts

export const VOICE_SUMMARY_PROMPTS = ["linkedin/voice-summary", "linkedin/voice-summary-tool"] as const;
type VoicePromptName = (typeof VOICE_SUMMARY_PROMPTS)[number];
const CODE_TEMPLATES: PromptTemplates<VoicePromptName> = codeTemplates(VOICE_SUMMARY_PROMPTS);

const VOICE_FIELDS = ["sound", "format", "language", "phrases", "topics"] as const;
const MAX_FIELD = 2000;

export function voiceSummarySchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [...VOICE_FIELDS],
    properties: Object.fromEntries(VOICE_FIELDS.map((field) => [field, { type: "string", maxLength: MAX_FIELD }])),
  };
}

/** The voice summary as blocks, titled as the dialog's hints. Throws on an off-schema answer, so `accept` can retry. Pure. */
export function voiceSummaryBlocks(raw: unknown): AiInstructionBlock[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("The voice summary is malformed JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The voice summary must be an object");
  const object = value as Record<string, unknown>;
  const extra = Object.keys(object).filter((key) => !(VOICE_FIELDS as readonly string[]).includes(key));
  if (extra.length) throw new Error(`The voice summary has unknown field(s): ${extra.join(", ")}`);
  const blocks: AiInstructionBlock[] = [];
  for (const field of VOICE_FIELDS) {
    const text = object[field];
    if (text !== undefined && typeof text !== "string") throw new Error(`${field} must be text`);
    const content = (text ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_FIELD);
    const hint = VOICE_BLOCK_HINTS.find((item) => item.id === field)!;
    if (content) blocks.push({ id: hint.id, title: hint.title, content });
  }
  if (!blocks.length) throw new Error("The voice summary is empty");
  return blocks;
}

export type LearnVoiceDependencies = {
  read?: PastPostsReader;
  complete?: PostCompletion;
  resolve?: (names: readonly VoicePromptName[]) => Promise<{ templates: PromptTemplates<VoicePromptName>; prompts: ResolvedPrompt[] }>;
};

export const completeVoiceSummaryWithOpenRouter: PostCompletion = (input) =>
  completeStructuredWithOpenRouter({
    timeoutMs: input.timeoutMs,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    maxOutputTokens: input.maxOutputTokens,
    jsonSchema: input.jsonSchema,
    schemaName: "linkedin_voice_summary",
    schemaDescription: input.toolDescription,
    accept: input.accept,
    signal: input.signal,
    trace: input.trace,
  });

/**
 * "Learn from my posts": the account's last ~20 posts, described as voice
 * blocks for the person to edit. Saves nothing. 409 when the account is
 * disconnected or has no posts to read.
 */
export async function learnAuthorVoice(linkedinAccountId: string, dependencies: LearnVoiceDependencies = {}): Promise<{ instructions: AiInstructionBlock[]; postsRead: number }> {
  const account = await accountInOrg(linkedinAccountId);
  if (account.status !== "CONNECTED") throw new PostApiError(409, "This account is disconnected, so its posts cannot be read. Reconnect it first.");
  let posts: string[];
  try {
    posts = await (dependencies.read ?? readPastPostsFromUnipile)(account.linkedinId, VOICE_LEARN_POSTS);
  } catch (error) {
    console.warn("[linkedin/posts] could not read posts to learn a voice", { accountId: account.id, error: error instanceof Error ? error.message : String(error) });
    throw new PostApiError(502, "This account's posts could not be read from LinkedIn. Try again later.");
  }
  if (!posts.length) throw new PostApiError(409, "This account has no posts of its own to learn from yet.");

  const resolve = dependencies.resolve ?? ((names) => resolveTemplates(names));
  const { templates, prompts } = await resolve(VOICE_SUMMARY_PROMPTS);
  const merged = { ...CODE_TEMPLATES, ...templates };
  const completion = await (dependencies.complete ?? completeVoiceSummaryWithOpenRouter)({
    systemPrompt: fillPrompt(merged["linkedin/voice-summary"], {}),
    userPrompt: JSON.stringify({ author: { name: account.name, headline: account.headline }, posts }, null, 2),
    toolDescription: fillPrompt(merged["linkedin/voice-summary-tool"], {}),
    jsonSchema: voiceSummarySchema(),
    accept: (text) => {
      voiceSummaryBlocks(text);
    },
    timeoutMs: 60_000,
    maxOutputTokens: 3_000,
    trace: { name: "linkedin-voice-summary", prompts, metadata: { linkedinAccountId: account.id, posts: posts.length } },
  });
  return { instructions: voiceSummaryBlocks(completion.text), postsRead: posts.length };
}
