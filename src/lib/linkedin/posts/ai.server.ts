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
  type PostTheme,
  type PostThemesResponse,
} from "./contract";
import { generatePostDrafts, rewritePost, type PostDraftDependencies, type PostDraftResult, type PostKnowledgeDocument } from "./draft";
import { describeLeaks, findLeaks, type LeakTerm } from "./leakGuard";
import { findPostThemes, guardTermsFor, verifyTheme, type ThemeDependencies } from "./themes.server";
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

/** The theme's seal must be this organization's: a theme from elsewhere, or edited in the browser, is refused. */
function assertThemeSealed(theme: PostTheme | null | undefined): void {
  if (theme && !verifyTheme(theme)) throw new PostApiError(400, "This theme is out of date or was changed. Find themes again.");
}

/** The account and Knowledge a draft is written from, all the organization's own. */
export async function resolvePostSources(input: { linkedinAccountId: string; topic: string | null; knowledgeDocumentIds: string[]; theme?: PostTheme | null }): Promise<ResolvedPostSources> {
  assertThemeSealed(input.theme);
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
  const base = { ...(input.topic ? { topic: input.topic } : {}), ...(used.length ? { knowledgeDocumentIds: used } : {}) };
  return {
    account,
    knowledge: picked.map(asDocument),
    companyContext: always.map(asDocument),
    source: input.theme
      ? // Server-written: the theme's title and summary and when it was read, sealed; never a message or person id.
        { kind: "conversations", ...base, themeTitle: input.theme.title, themeSummary: input.theme.summary, themesReadAt: input.theme.readAt, seal: input.theme.seal }
      : { kind: picked.length ? "knowledge" : "topic", ...base },
  };
}

export type PostAiDependencies = PostDraftDependencies & {
  loadVoice?: (account: VoiceAccount) => Promise<AuthorVoice>;
  /** The leak guard's terms for a theme read at a time; the source set in the database by default. */
  guardTerms?: (readAt: Date) => Promise<LeakTerm[]>;
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

/**
 * The leak guard over drafts from a theme: a draft naming anyone in the
 * theme's source set is held back, with what matched. Drafts from a topic or
 * Knowledge pass as they are.
 */
async function guardDrafts(result: PostDraftResult, theme: PostTheme | null, dependencies: PostAiDependencies) {
  if (!theme) return { variants: result.variants, withheld: [] };
  const terms = await (dependencies.guardTerms ?? guardTermsFor)(new Date(theme.readAt));
  const variants: { body: string }[] = [];
  const withheld: { matched: string }[] = [];
  for (const variant of result.variants) {
    const leaks = findLeaks(variant.body, terms);
    if (leaks.length) withheld.push({ matched: describeLeaks(leaks) });
    else variants.push(variant);
  }
  return { variants, withheld };
}

async function respond(result: PostDraftResult, source: LinkedinPostSource, voice: AuthorVoice, theme: PostTheme | null, dependencies: PostAiDependencies): Promise<PostDraftsResponse> {
  const guarded = await guardDrafts(result, theme, dependencies);
  return {
    variants: guarded.variants,
    withheld: guarded.withheld,
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
        theme: input.theme,
        metadata: { linkedinAccountId: sources.account.id, knowledgeDocuments: sources.knowledge.length, companyContext: sources.companyContext.length, theme: Boolean(input.theme) },
      },
      dependencies,
    ),
  );
  return respond(result, sources.source, voice, input.theme ?? null, dependencies);
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
        theme: input.theme,
        metadata: { linkedinAccountId: sources.account.id, knowledgeDocuments: sources.knowledge.length, companyContext: sources.companyContext.length, theme: Boolean(input.theme) },
      },
      dependencies,
    ),
  );
  // A rewrite keeps how the post was sourced; without sources of its own it says so plainly.
  const source: LinkedinPostSource =
    input.theme || input.topic || input.knowledgeDocumentIds.length
      ? sources.source
      : { kind: "blank", ...(sources.source.knowledgeDocumentIds ? { knowledgeDocumentIds: sources.source.knowledgeDocumentIds } : {}) };
  return respond(result, source, voice, input.theme ?? null, dependencies);
}

/** POST /themes: what prospects said in the last 30 days, as themes to write from. */
export async function postThemes(dependencies: PostAiDependencies & ThemeDependencies = {}): Promise<PostThemesResponse> {
  if (!dependencies.skipOpenRouterCheck) await requireOpenRouter();
  return guarded(() => findPostThemes(dependencies));
}
