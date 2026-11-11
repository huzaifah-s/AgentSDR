import "server-only";

import { completeStructuredWithOpenRouter, type StructuredCompletionTrace } from "@/lib/ai/server/structuredCompletion";
import type { ResolvedPrompt } from "@/lib/observability/langfuse";
import type { PromptName } from "@/lib/prompts/registry";
import { fillPrompt } from "@/lib/prompts/template";
import { codeTemplates, type PromptTemplates } from "@/lib/prompts/templates";
import { resolveTemplates } from "@/lib/prompts/templates.server";
import { countHashtags, MAX_POST_LENGTH, POST_DRAFT_VARIANTS, type LinkedinPostGeneration } from "./contract";

/**
 * AI drafts of LinkedIn posts (docs/linkedin-content/plan.md, Phase 2),
 * after the pattern of CRM drafts (src/lib/crm/ai/draft.ts): a pure prompt
 * builder, the templates from Langfuse (or the copies in code), one
 * structured OpenRouter call whose answer is checked in `accept` so an
 * off-schema one is retried, and an injectable completion so tests never
 * reach a model or Langfuse.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
// Three posts of up to 3,000 characters each, plus a reasoning model's thinking.
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
/** Most hashtags a post may end with, when the author uses them at all. */
export const MAX_POST_HASHTAGS = 3;

export const POST_DRAFT_PROMPTS = [
  "linkedin/post-system",
  "linkedin/post-user",
  "linkedin/post-tool",
] as const satisfies readonly PromptName[];
export const POST_REWRITE_PROMPTS = [
  "linkedin/post-system",
  "linkedin/post-rewrite",
  "linkedin/post-tool",
] as const satisfies readonly PromptName[];

type PostPromptName = (typeof POST_DRAFT_PROMPTS)[number] | (typeof POST_REWRITE_PROMPTS)[number];
export type PostTemplates = PromptTemplates<PostPromptName>;
const CODE_TEMPLATES: PostTemplates = codeTemplates([...new Set<PostPromptName>([...POST_DRAFT_PROMPTS, ...POST_REWRITE_PROMPTS])]);

export type PostAuthor = { name: string | null; headline: string | null };

/** A Knowledge document, whole: the latest version's content, never cut. */
export type PostKnowledgeDocument = { id: string; title: string; kind: string; content: string };

export type PostPromptInput = {
  author: PostAuthor;
  /** The account's own recent posts, newest first. Empty when there are none or they could not be read. */
  pastPosts: readonly string[];
  topic: string | null;
  /** Documents the rep picked. */
  knowledge: readonly PostKnowledgeDocument[];
  /** Always added: the organization's Knowledge marked always include and tagged public. */
  companyContext: readonly PostKnowledgeDocument[];
  /**
   * A prospects' theme (Phase 4): its title and summary only, never the
   * messages it was found in.
   */
  theme?: { title: string; summary: string } | null;
};

export type RewritePromptInput = PostPromptInput & { currentPost: string; instruction: string };

export type BuiltPostPrompt = {
  systemPrompt: string;
  userPrompt: string;
  /** The tool's description, as shown to the model. */
  toolDescription: string;
  snapshot: Record<string, unknown>;
  jsonSchema: Record<string, unknown>;
  /** What `accept` holds the answer to. */
  rules: PostOutputRules;
};

export type PostOutputRules = {
  count: number;
  maxHashtags: number;
  /** A rewrite must not hand back the post it was given. */
  differentFrom?: string;
};

function clean(value: string | null | undefined): string | null {
  const text = value?.replace(/\r\n?/g, "\n").trim();
  return text ? text : null;
}

function documents(list: readonly PostKnowledgeDocument[], label: string) {
  const seen = new Set<string>();
  return list.flatMap((document) => {
    if (seen.has(document.id)) return [];
    seen.add(document.id);
    const content = clean(document.content);
    const title = clean(document.title);
    if (!title) throw new Error(`${label} document ${document.id} has no title`);
    // An empty document adds nothing; Knowledge versions cannot be empty, so this is defensive.
    return content ? [{ title, kind: document.kind, content }] : [];
  });
}

/** Whether the author's own posts use hashtags, which is what allows them in a draft. */
export function pastPostsUseHashtags(pastPosts: readonly string[]): boolean {
  return pastPosts.some((post) => countHashtags(post) > 0);
}

export function postsJsonSchema(count: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["posts"],
    properties: {
      posts: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["body"],
          properties: { body: { type: "string", minLength: 1, maxLength: MAX_POST_LENGTH } },
        },
      },
    },
  };
}

/** The context every post prompt carries, and the system prompt over it. */
function baseContext(input: PostPromptInput, templates: PostTemplates) {
  const pastPosts = input.pastPosts.map((post) => clean(post)).filter((post): post is string => Boolean(post));
  const knowledge = documents(input.knowledge, "Knowledge");
  const picked = new Set(input.knowledge.map((document) => document.id));
  // A picked document that is also always added is sent once, as picked.
  const companyContext = documents(input.companyContext.filter((document) => !picked.has(document.id)), "Company context");
  const hashtags = pastPostsUseHashtags(pastPosts);

  const snapshot: Record<string, unknown> = {
    author: { name: clean(input.author.name), headline: clean(input.author.headline) },
    pastPosts,
  };
  const topic = clean(input.topic);
  if (topic) snapshot.topic = topic;
  if (knowledge.length) snapshot.knowledge = knowledge;
  if (companyContext.length) snapshot.companyContext = companyContext;
  const themeTitle = clean(input.theme?.title);
  const themeSummary = clean(input.theme?.summary);
  const theme = themeTitle && themeSummary ? { title: themeTitle, summary: themeSummary } : null;
  if (theme) snapshot.theme = theme;

  const systemPrompt = fillPrompt(templates["linkedin/post-system"], {
    past_posts: pastPosts.length > 0,
    hashtags,
    theme: Boolean(theme),
    max_length: MAX_POST_LENGTH.toLocaleString("en-US"),
  });
  return { snapshot, systemPrompt, topic, hasKnowledge: knowledge.length > 0, hasTheme: Boolean(theme), hashtags };
}

/** The prompt for new drafts: `variants` different posts from the topic and Knowledge. Pure. */
export function buildPostPrompt(
  input: PostPromptInput,
  templates: PostTemplates = CODE_TEMPLATES,
  variants: number = POST_DRAFT_VARIANTS,
): BuiltPostPrompt {
  const { snapshot, systemPrompt, topic, hasKnowledge, hasTheme, hashtags } = baseContext(input, templates);
  if (!topic && !hasKnowledge && !hasTheme) throw new Error("A post draft needs a topic, a theme or a Knowledge document");
  return {
    systemPrompt,
    userPrompt: fillPrompt(templates["linkedin/post-user"], {
      variants,
      topic: Boolean(topic),
      theme: hasTheme,
      context_json: JSON.stringify(snapshot, null, 2),
    }),
    toolDescription: fillPrompt(templates["linkedin/post-tool"], {}),
    snapshot,
    jsonSchema: postsJsonSchema(variants),
    rules: { count: variants, maxHashtags: hashtags ? MAX_POST_HASHTAGS : 0 },
  };
}

/** The prompt for a rewrite of the current text, as the instruction asks: one post. Pure. */
export function buildRewritePrompt(input: RewritePromptInput, templates: PostTemplates = CODE_TEMPLATES): BuiltPostPrompt {
  const { snapshot, systemPrompt, hashtags } = baseContext(input, templates);
  const currentPost = clean(input.currentPost);
  const instruction = clean(input.instruction);
  if (!currentPost) throw new Error("There is no text to rewrite");
  if (!instruction) throw new Error("Say how to rewrite the post");
  // Hashtags the rep already wrote are theirs to keep; otherwise the author's habit decides.
  const own = countHashtags(currentPost);
  const maxHashtags = hashtags || own > 0 ? Math.max(MAX_POST_HASHTAGS, own) : 0;
  return {
    systemPrompt,
    userPrompt: fillPrompt(templates["linkedin/post-rewrite"], {
      context_json: JSON.stringify({ currentPost, instruction, ...snapshot }, null, 2),
    }),
    toolDescription: fillPrompt(templates["linkedin/post-tool"], {}),
    snapshot: { currentPost, instruction, ...snapshot },
    jsonSchema: postsJsonSchema(1),
    rules: { count: 1, maxHashtags, differentFrom: currentPost },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The model's answer, held to the schema and the rules: exactly `count`
 * posts, each non-empty, at most 3,000 characters and `maxHashtags`
 * hashtags, no two the same. Throws with the reason, so `accept` can retry.
 */
export function validatePostsOutput(raw: unknown, rules: PostOutputRules): { body: string }[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("The post writer returned malformed JSON");
    }
  }
  if (!isPlainObject(value)) throw new Error("The post writer's answer must be a JSON object");
  const extra = Object.keys(value).filter((key) => key !== "posts");
  if (extra.length) throw new Error(`The post writer returned unknown field(s): ${extra.join(", ")}`);
  if (!Array.isArray(value.posts)) throw new Error("The post writer returned no posts");
  if (value.posts.length !== rules.count) throw new Error(`The post writer returned ${value.posts.length} posts, not ${rules.count}`);

  const bodies = value.posts.map((post, index) => {
    if (!isPlainObject(post)) throw new Error(`Post ${index + 1} must be an object`);
    const keys = Object.keys(post).filter((key) => key !== "body");
    if (keys.length) throw new Error(`Post ${index + 1} has unknown field(s): ${keys.join(", ")}`);
    if (typeof post.body !== "string") throw new Error(`Post ${index + 1} has no body`);
    const body = post.body.replace(/\r\n?/g, "\n").trim();
    if (!body) throw new Error(`Post ${index + 1} is empty`);
    if (body.length > MAX_POST_LENGTH) throw new Error(`Post ${index + 1} is ${body.length} characters; the limit is ${MAX_POST_LENGTH}`);
    const hashtags = countHashtags(body);
    if (hashtags > rules.maxHashtags) {
      throw new Error(rules.maxHashtags === 0 ? `Post ${index + 1} uses hashtags; the author does not` : `Post ${index + 1} has ${hashtags} hashtags; at most ${rules.maxHashtags}`);
    }
    return body;
  });
  if (new Set(bodies).size !== bodies.length) throw new Error("The post writer returned the same post twice");
  if (rules.differentFrom !== undefined && bodies.includes(rules.differentFrom.trim())) {
    throw new Error("The rewrite is the same as the current post");
  }
  return bodies.map((body) => ({ body }));
}

// ------------------------------------------------------------------ the call

export type PostCompletionInput = Omit<BuiltPostPrompt, "snapshot" | "rules"> & {
  /** Rejects an attempt by throwing; the completion may then try again. */
  accept: (text: string) => void;
  timeoutMs: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
  trace: StructuredCompletionTrace;
};

export type PostCompletionResult = {
  text: string;
  provider: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type PostCompletion = (input: PostCompletionInput) => Promise<PostCompletionResult>;

/** The organization's default OpenRouter model (AI Settings), as CRM drafts use it. */
export const completePostWithOpenRouter: PostCompletion = (input) =>
  completeStructuredWithOpenRouter({
    timeoutMs: input.timeoutMs,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    maxOutputTokens: input.maxOutputTokens,
    jsonSchema: input.jsonSchema,
    schemaName: "linkedin_posts",
    schemaDescription: input.toolDescription,
    accept: input.accept,
    signal: input.signal,
    trace: input.trace,
  });

export type PostTemplateResolver = (names: readonly PostPromptName[]) => Promise<{ templates: PromptTemplates<PostPromptName>; prompts: ResolvedPrompt[] }>;

export type PostDraftDependencies = {
  complete?: PostCompletion;
  /** The templates and their versions; Langfuse (or the copies in code) by default. */
  resolve?: PostTemplateResolver;
};

export type PostDraftResult = {
  variants: { body: string }[];
  generation: LinkedinPostGeneration;
  provider: string;
  usage?: PostCompletionResult["usage"];
  prompt: BuiltPostPrompt;
};

/** What a trace may carry about the draft: ids and counts, never the text. */
export type PostTraceMetadata = Record<string, string | number | boolean | null>;

async function run(
  kind: "draft" | "rewrite",
  names: readonly PostPromptName[],
  build: (templates: PostTemplates) => BuiltPostPrompt,
  options: { signal?: AbortSignal; metadata?: PostTraceMetadata },
  dependencies: PostDraftDependencies,
): Promise<PostDraftResult> {
  const resolve = dependencies.resolve ?? ((list: readonly PostPromptName[]) => resolveTemplates(list));
  const { templates, prompts } = await resolve(names);
  const prompt = build({ ...CODE_TEMPLATES, ...templates });
  const { rules } = prompt;
  const completion = await (dependencies.complete ?? completePostWithOpenRouter)({
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    toolDescription: prompt.toolDescription,
    jsonSchema: prompt.jsonSchema,
    accept: (text) => {
      validatePostsOutput(text, rules);
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    signal: options.signal,
    trace: {
      name: kind === "draft" ? "linkedin-post-draft" : "linkedin-post-rewrite",
      prompts,
      metadata: { ...options.metadata, variants: rules.count, pastPosts: (prompt.snapshot.pastPosts as unknown[]).length },
    },
  });
  const model = completion.model?.trim();
  if (!model) throw new Error("The post writer's completion named no model");
  return {
    variants: validatePostsOutput(completion.text, rules),
    generation: { model, prompts: prompts.map((resolved) => ({ name: resolved.name, version: resolved.version })) },
    provider: completion.provider,
    usage: completion.usage,
    prompt,
  };
}

/** Three drafts from the topic and Knowledge, in the author's voice. */
export function generatePostDrafts(
  input: PostPromptInput & { signal?: AbortSignal; metadata?: PostTraceMetadata },
  dependencies: PostDraftDependencies = {},
): Promise<PostDraftResult> {
  return run("draft", POST_DRAFT_PROMPTS, (templates) => buildPostPrompt(input, templates), input, dependencies);
}

/** One rewrite of the current text, as the instruction asks. */
export function rewritePost(
  input: RewritePromptInput & { signal?: AbortSignal; metadata?: PostTraceMetadata },
  dependencies: PostDraftDependencies = {},
): Promise<PostDraftResult> {
  return run("rewrite", POST_REWRITE_PROMPTS, (templates) => buildRewritePrompt(input, templates), input, dependencies);
}
