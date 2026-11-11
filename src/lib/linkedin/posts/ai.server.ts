import "server-only";

import { and, eq } from "drizzle-orm";
import { getOpenRouterRuntime } from "@/lib/ai/server/runtime";
import { completeStructuredWithOpenRouter } from "@/lib/ai/server/structuredCompletion";
import type { ResolvedPrompt } from "@/lib/observability/langfuse";
import { resolveTemplates } from "@/lib/prompts/templates.server";
import { formatAiInstructions } from "@/lib/crm/ai/instructions";
import { loadPostInstructions } from "@/lib/crm/aiSettings";
import { listKnowledgeDocuments } from "@/lib/crm/knowledge-service";
import { db } from "@/lib/db";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { inOrg } from "@/lib/tenancy/scope";
import {
  isAlwaysAddedKnowledge,
  hasPublicTag,
  sortKnowledgeForPosts,
  type LinkedinPostSource,
  type PostDraftsResponse,
  type PostKnowledgeOption,
  type PostIdeasResponse,
  type PostTheme,
  type PostThemesResponse,
} from "./contract";
import { generatePostDrafts, rewritePost, type PostCompletion, type PostDraftDependencies, type PostDraftResult, type PostKnowledgeDocument } from "./draft";
import { describeLeaks, findLeaks, type LeakTerm } from "./leakGuard";
import { findPostThemes, guardTermsFor, verifyTheme, type ThemeDependencies } from "./themes.server";
import { PostApiError } from "./posts.server";
import type { GenerateDraftsInput, PostIdeasInput, RewriteDraftInput } from "./requests";
import { buildIdeasPrompt, IDEA_PROMPTS, toIdeas, validateIdeasOutput, type IdeaInput, type IdeaTemplates } from "./ideas";
import { DEFAULT_POST_INSTRUCTIONS } from "./postInstructions";
import { loadAuthorVoice as sharedVoiceLoader, type AuthorVoice, type VoiceAccount } from "./voice.server";
import { voiceForDraft } from "./voices.server";

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
      isPublic: hasPublicTag(document.tags),
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
  /** The content brief, rendered (Phase 5); the organization's, or the defaults, by default. */
  loadBrief?: () => Promise<string | null>;
  /** The account's own written voice (Phase 5); its linkedin_author_voices row by default. */
  loadWrittenVoice?: (linkedinAccountId: string) => Promise<{ instructions: string | null; examplePosts: string[] } | null>;
  /** Skips the OpenRouter check, for a caller that injects `complete` (tests). */
  skipOpenRouterCheck?: boolean;
};

/** The organization's content brief as the prompt reads it: its own blocks, or the defaults while it has none. */
export async function postBrief(): Promise<string | null> {
  return formatAiInstructions((await loadPostInstructions()) ?? DEFAULT_POST_INSTRUCTIONS);
}

/** The brief and the account's written voice, the two layers above a draft's own notes. */
async function layersFor(linkedinAccountId: string, dependencies: PostAiDependencies) {
  const [brief, voice] = await Promise.all([
    (dependencies.loadBrief ?? postBrief)(),
    (dependencies.loadWrittenVoice ?? voiceForDraft)(linkedinAccountId),
  ]);
  return { brief, voice };
}

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
  const layers = await layersFor(sources.account.id, dependencies);
  const result = await guarded(() =>
    generatePostDrafts(
      {
        ...layers,
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
  const layers = await layersFor(sources.account.id, dependencies);
  const result = await guarded(() =>
    rewritePost(
      {
        ...layers,
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

// ------------------------------------------------------------ post ideas (Phase 5)

export const completeIdeasWithOpenRouter: PostCompletion = (input) =>
  completeStructuredWithOpenRouter({
    timeoutMs: input.timeoutMs,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    maxOutputTokens: input.maxOutputTokens,
    jsonSchema: input.jsonSchema,
    schemaName: "linkedin_post_ideas",
    schemaDescription: input.toolDescription,
    accept: input.accept,
    signal: input.signal,
    trace: input.trace,
  });

export type PostIdeasDependencies = PostAiDependencies &
  ThemeDependencies & {
    /** The ideas call; the themes call, when themes are read, is `complete`. */
    completeIdeas?: PostCompletion;
    resolveIdeas?: (names: readonly (typeof IDEA_PROMPTS)[number][]) => Promise<{ templates: IdeaTemplates; prompts: ResolvedPrompt[] }>;
  };

/**
 * POST /ideas: 5 post ideas from the brief's pillars, the organization's
 * public Knowledge and (unless turned off) prospects' themes, read first with
 * their own call. An idea drawing on a theme is held to the leak guard like
 * a draft, and opens as a draft with that theme's sealed source.
 */
export async function suggestPostIdeas(input: PostIdeasInput, dependencies: PostIdeasDependencies = {}): Promise<PostIdeasResponse> {
  if (!dependencies.skipOpenRouterCheck) await requireOpenRouter();
  return guarded(async () => {
    const [brief, rows] = await Promise.all([(dependencies.loadBrief ?? postBrief)(), knowledgeRows()]);
    const knowledge = rows.filter((row) => row.isPublic).map((row): PostKnowledgeDocument => ({ id: row.id, title: row.title, kind: row.kind, content: row.content }));
    const themes = input.includeThemes ? (await findPostThemes(dependencies)).themes : [];
    const ideaInput: IdeaInput = { brief, knowledge, themes };

    const resolve = dependencies.resolveIdeas ?? ((names) => resolveTemplates(names));
    const { templates, prompts } = await resolve(IDEA_PROMPTS);
    const prompt = buildIdeasPrompt(ideaInput, templates);
    const completion = await (dependencies.completeIdeas ?? completeIdeasWithOpenRouter)({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      toolDescription: prompt.toolDescription,
      jsonSchema: prompt.jsonSchema,
      accept: (text) => {
        validateIdeasOutput(text, prompt.refs);
      },
      timeoutMs: 90_000,
      maxOutputTokens: 4_000,
      trace: { name: "linkedin-post-ideas", prompts, metadata: { knowledge: knowledge.length, themes: themes.length } },
    });
    const ideas = toIdeas(validateIdeasOutput(completion.text, prompt.refs), ideaInput);

    // The leak guard, as over drafts, on every idea once themes were read.
    const readAt = themes[0]?.readAt;
    const terms = readAt ? await (dependencies.guardTerms ?? guardTermsFor)(new Date(readAt)) : [];
    const kept = ideas.filter((idea) => findLeaks(`${idea.title}\n${idea.angle}`, terms).length === 0);
    return { ideas: kept, withheld: ideas.length - kept.length, themes: themes.length };
  });
}
