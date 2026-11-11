import "server-only";

import { and, eq } from "drizzle-orm";
import { getOpenRouterRuntime } from "@/lib/ai/server/runtime";
import { listKnowledgeDocuments } from "@/lib/crm/knowledge-service";
import { db } from "@/lib/db";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { inOrg } from "@/lib/tenancy/scope";
import {
  isAlwaysAddedKnowledge,
  PUBLIC_KNOWLEDGE_TAG,
  sortKnowledgeForPosts,
  type LinkedinPostSource,
  type PostDraftsResponse,
  type PostKnowledgeOption,
} from "./contract";
import { generatePostDrafts, rewritePost, type PostDraftDependencies, type PostDraftResult, type PostKnowledgeDocument } from "./draft";
import { PostApiError } from "./posts.server";
import type { GenerateDraftsInput, RewriteDraftInput } from "./requests";
import { loadAuthorVoice as sharedVoiceLoader, type AuthorVoice, type VoiceAccount } from "./voice.server";

/**
 * The AI half of the composer, in the organization in scope: which Knowledge
 * it may use, whether OpenRouter is ready, and the two calls behind
 * /api/linkedin/posts/generate and /rewrite. Every read is the
 * organization's own: another organization's account or document is "not
 * found", before anything reaches LinkedIn or a model.
 */

/**
 * Whether drafts can run: OpenRouter connected, BYOK-only confirmed and a
 * default model chosen (what getOpenRouterRuntime checks before a call).
 * Reads only the organization's own settings; nothing leaves the machine.
 */
export async function openRouterProblem(): Promise<string | null> {
  try {
    await getOpenRouterRuntime();
    return null;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
    return `Writing posts with AI needs OpenRouter: ${message} (Settings → AI provider).`;
  }
}

export async function requireOpenRouter(): Promise<void> {
  const problem = await openRouterProblem();
  if (problem) throw new PostApiError(409, problem);
}

type KnowledgeRow = PostKnowledgeOption & { content: string };

async function knowledgeRows(): Promise<KnowledgeRow[]> {
  const documents = await listKnowledgeDocuments({});
  return sortKnowledgeForPosts(
    documents.map((document) => ({
      id: document.id,
      title: document.title,
      kind: document.kind,
      alwaysInclude: document.alwaysInclude,
      isPublic: document.tags.includes(PUBLIC_KNOWLEDGE_TAG),
      content: document.latest?.content ?? "",
      chars: document.latest?.content?.trim().length ?? 0,
    })),
  );
}

/** The organization's active Knowledge for the composer's picker (no content), case studies, objections and FAQs first. */
export async function listPostKnowledge(): Promise<PostKnowledgeOption[]> {
  return (await knowledgeRows()).map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    alwaysInclude: row.alwaysInclude,
    isPublic: row.isPublic,
    chars: row.chars,
  }));
}

async function accountInOrg(linkedinAccountId: string): Promise<VoiceAccount & { status: string }> {
  const [account] = await db
    .select({
      id: linkedInAccounts.id,
      linkedinId: linkedInAccounts.linkedinId,
      name: linkedInAccounts.name,
      headline: linkedInAccounts.headline,
      status: linkedInAccounts.status,
    })
    .from(linkedInAccounts)
    .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, linkedinAccountId)));
  // The same answer as for an unknown id, as when a post is saved.
  if (!account) throw new PostApiError(400, "Choose one of your organization's LinkedIn accounts");
  return account;
}

export type ResolvedPostSources = {
  account: VoiceAccount & { status: string };
  knowledge: PostKnowledgeDocument[];
  companyContext: PostKnowledgeDocument[];
  source: LinkedinPostSource;
};

/** The account and Knowledge a draft is written from, all the organization's own. */
export async function resolvePostSources(input: { linkedinAccountId: string; topic: string | null; knowledgeDocumentIds: string[] }): Promise<ResolvedPostSources> {
  const account = await accountInOrg(input.linkedinAccountId);
  const rows = await knowledgeRows();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const picked = input.knowledgeDocumentIds.map((id) => {
    const row = byId.get(id);
    if (!row) throw new PostApiError(400, "One of the chosen Knowledge documents was not found. Reload and choose again.");
    return row;
  });
  const pickedIds = new Set(picked.map((row) => row.id));
  const always = rows.filter((row) => isAlwaysAddedKnowledge(row) && !pickedIds.has(row.id));
  const asDocument = (row: KnowledgeRow): PostKnowledgeDocument => ({ id: row.id, title: row.title, kind: row.kind, content: row.content });
  const used = [...picked, ...always].map((row) => row.id);
  return {
    account,
    knowledge: picked.map(asDocument),
    companyContext: always.map(asDocument),
    source: {
      kind: picked.length ? "knowledge" : "topic",
      ...(input.topic ? { topic: input.topic } : {}),
      ...(used.length ? { knowledgeDocumentIds: used } : {}),
    },
  };
}

export type PostAiDependencies = PostDraftDependencies & {
  loadVoice?: (account: VoiceAccount) => Promise<AuthorVoice>;
  /** Skips the OpenRouter check, for a caller that injects `complete` (tests). */
  skipOpenRouterCheck?: boolean;
};

async function voiceFor(account: ResolvedPostSources["account"], dependencies: PostAiDependencies): Promise<AuthorVoice> {
  // A disconnected account cannot be read; the draft goes ahead without its past posts.
  if (account.status !== "CONNECTED") {
    return { name: account.name, headline: account.headline, pastPosts: [], status: "unavailable" };
  }
  return (dependencies.loadVoice ?? sharedVoiceLoader)(account);
}

function respond(result: PostDraftResult, source: LinkedinPostSource, voice: AuthorVoice): PostDraftsResponse {
  return {
    variants: result.variants,
    source,
    generation: result.generation,
    voice: { status: voice.status, pastPosts: voice.pastPosts.length },
  };
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PostApiError) throw error;
    console.error("[linkedin/posts] AI draft failed", error);
    const reason = error instanceof Error ? error.message : String(error);
    throw new PostApiError(502, `The AI could not write this post: ${reason.slice(0, 300)}`);
  }
}

/** POST /generate: three drafts from the topic and Knowledge, in the account's voice. */
export async function draftPosts(input: GenerateDraftsInput, dependencies: PostAiDependencies = {}): Promise<PostDraftsResponse> {
  const sources = await resolvePostSources(input);
  if (!dependencies.skipOpenRouterCheck) await requireOpenRouter();
  const voice = await voiceFor(sources.account, dependencies);
  const result = await guarded(() =>
    generatePostDrafts(
      {
        author: { name: voice.name, headline: voice.headline },
        pastPosts: voice.pastPosts,
        topic: input.topic,
        knowledge: sources.knowledge,
        companyContext: sources.companyContext,
        metadata: { linkedinAccountId: sources.account.id, knowledgeDocuments: sources.knowledge.length, companyContext: sources.companyContext.length },
      },
      dependencies,
    ),
  );
  return respond(result, sources.source, voice);
}

/** POST /rewrite: the current text once more, as the instruction asks. */
export async function rewritePostDraft(input: RewriteDraftInput, dependencies: PostAiDependencies = {}): Promise<PostDraftsResponse> {
  const sources = await resolvePostSources(input);
  if (!dependencies.skipOpenRouterCheck) await requireOpenRouter();
  const voice = await voiceFor(sources.account, dependencies);
  const result = await guarded(() =>
    rewritePost(
      {
        author: { name: voice.name, headline: voice.headline },
        pastPosts: voice.pastPosts,
        topic: input.topic,
        knowledge: sources.knowledge,
        companyContext: sources.companyContext,
        currentPost: input.body,
        instruction: input.instruction,
        metadata: { linkedinAccountId: sources.account.id, knowledgeDocuments: sources.knowledge.length, companyContext: sources.companyContext.length },
      },
      dependencies,
    ),
  );
  // A rewrite keeps how the post was sourced; without sources of its own it says so plainly.
  const source: LinkedinPostSource = input.topic || input.knowledgeDocumentIds.length ? sources.source : { kind: "blank", ...(sources.source.knowledgeDocumentIds ? { knowledgeDocumentIds: sources.source.knowledgeDocumentIds } : {}) };
  return respond(result, source, voice);
}
