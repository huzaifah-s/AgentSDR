/**
 * "Suggest ideas" on the Posts page (docs/linkedin-content/plan.md, Phase 5),
 * the pure half: the prompt over the brief, public Knowledge and prospects'
 * themes, the check of the answer, and each idea's source — what the draft
 * it opens as records. ai.server.ts reads the sources and makes the call.
 */
import { fillPrompt } from "@/lib/prompts/template";
import { codeTemplates, type PromptTemplates } from "@/lib/prompts/templates";
import { MAX_TOPIC_LENGTH, POST_IDEA_COUNT, type LinkedinPostSource, type PostIdea, type PostTheme } from "./contract";
import type { PostKnowledgeDocument } from "./draft";

export const IDEA_PROMPTS = ["linkedin/post-ideas", "linkedin/post-ideas-tool"] as const;
type IdeaPromptName = (typeof IDEA_PROMPTS)[number];
export type IdeaTemplates = PromptTemplates<IdeaPromptName>;
const CODE_TEMPLATES: IdeaTemplates = codeTemplates(IDEA_PROMPTS);

const MAX_IDEA_TITLE = 160;
const MAX_IDEA_ANGLE = 600;
const MAX_PILLAR = 160;

export type IdeaInput = {
  brief: string | null;
  /** The organization's Knowledge tagged public, read whole. */
  knowledge: readonly PostKnowledgeDocument[];
  themes: readonly PostTheme[];
};

export type RawIdea = { title: string; angle: string; pillar: string | null; basedOn: string[] };

const knowledgeRef = (index: number) => `K${index + 1}`;
const themeRef = (index: number) => `T${index + 1}`;

export function ideasJsonSchema(count: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["ideas"],
    properties: {
      ideas: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "angle", "pillar", "basedOn"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: MAX_IDEA_TITLE },
            angle: { type: "string", minLength: 1, maxLength: MAX_IDEA_ANGLE },
            pillar: { type: ["string", "null"], maxLength: MAX_PILLAR },
            basedOn: { type: "array", items: { type: "string" }, maxItems: 10 },
          },
        },
      },
    },
  };
}

export type BuiltIdeasPrompt = {
  systemPrompt: string;
  userPrompt: string;
  toolDescription: string;
  jsonSchema: Record<string, unknown>;
  refs: { knowledge: string[]; themes: string[] };
};

/** The ideas prompt. The user message is the context JSON alone; every word of instruction is in the Langfuse prompt. Pure. */
export function buildIdeasPrompt(input: IdeaInput, templates: IdeaTemplates = CODE_TEMPLATES, count = POST_IDEA_COUNT): BuiltIdeasPrompt {
  const knowledge = input.knowledge.map((document, index) => ({ ref: knowledgeRef(index), title: document.title, kind: document.kind, content: document.content }));
  const themes = input.themes.map((theme, index) => ({ ref: themeRef(index), title: theme.title, kind: theme.kind, summary: theme.summary, mentions: theme.mentions }));
  return {
    systemPrompt: fillPrompt(templates["linkedin/post-ideas"], { count, postInstructions: input.brief?.trim() || null }),
    userPrompt: JSON.stringify({ knowledge, themes }, null, 2),
    toolDescription: fillPrompt(templates["linkedin/post-ideas-tool"], {}),
    jsonSchema: ideasJsonSchema(count),
    refs: { knowledge: knowledge.map((item) => item.ref), themes: themes.map((item) => item.ref) },
  };
}

/** The model's answer, held to the schema and the refs given. Throws with the reason, so `accept` can retry. */
export function validateIdeasOutput(raw: unknown, refs: BuiltIdeasPrompt["refs"], count = POST_IDEA_COUNT): RawIdea[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("The ideas answer is malformed JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The ideas answer must be an object");
  const ideas = (value as { ideas?: unknown }).ideas;
  if (!Array.isArray(ideas) || ideas.length !== count) throw new Error(`Give exactly ${count} ideas`);
  const known = new Set([...refs.knowledge, ...refs.themes]);
  const out = ideas.map((idea, index): RawIdea => {
    if (!idea || typeof idea !== "object") throw new Error(`Idea ${index + 1} must be an object`);
    const { title, angle, pillar, basedOn } = idea as Record<string, unknown>;
    const cleanTitle = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
    const cleanAngle = typeof angle === "string" ? angle.replace(/\s+/g, " ").trim() : "";
    if (!cleanTitle || cleanTitle.length > MAX_IDEA_TITLE) throw new Error(`Idea ${index + 1} needs a title`);
    if (!cleanAngle || cleanAngle.length > MAX_IDEA_ANGLE) throw new Error(`Idea ${index + 1} needs an angle`);
    if (pillar !== null && pillar !== undefined && typeof pillar !== "string") throw new Error(`Idea ${index + 1} has an invalid pillar`);
    if (!Array.isArray(basedOn) || basedOn.some((ref) => typeof ref !== "string")) throw new Error(`Idea ${index + 1} needs basedOn, a list of refs`);
    const unknown = (basedOn as string[]).filter((ref) => !known.has(ref.trim()));
    if (unknown.length) throw new Error(`Idea ${index + 1} names refs that were not given: ${unknown.join(", ")}`);
    return { title: cleanTitle, angle: cleanAngle, pillar: typeof pillar === "string" && pillar.trim() ? pillar.trim().slice(0, MAX_PILLAR) : null, basedOn: [...new Set((basedOn as string[]).map((ref) => ref.trim()))] };
  });
  if (new Set(out.map((idea) => idea.title.toLowerCase())).size !== out.length) throw new Error("Two ideas have the same title");
  return out;
}

/** "Title: angle", as the draft's topic. */
export function ideaTopic(idea: { title: string; angle: string }): string {
  const text = `${idea.title}: ${idea.angle}`;
  return text.length > MAX_TOPIC_LENGTH ? `${text.slice(0, MAX_TOPIC_LENGTH - 1).trimEnd()}…` : text;
}

/**
 * What the draft an idea opens as records: a theme it draws on (the first)
 * makes it a `conversations` source with that theme's seal, so the leak
 * guard follows it; otherwise its Knowledge, or its topic alone.
 */
export function ideaSource(idea: RawIdea, input: IdeaInput): LinkedinPostSource {
  const topic = ideaTopic(idea);
  const knowledgeDocumentIds = idea.basedOn.filter((ref) => ref.startsWith("K")).map((ref) => input.knowledge[Number(ref.slice(1)) - 1]?.id).filter((id): id is string => Boolean(id));
  const theme = idea.basedOn.filter((ref) => ref.startsWith("T")).map((ref) => input.themes[Number(ref.slice(1)) - 1]).find(Boolean);
  const knowledge = knowledgeDocumentIds.length ? { knowledgeDocumentIds } : {};
  if (theme) {
    return { kind: "conversations", topic, ...knowledge, themeTitle: theme.title, themeSummary: theme.summary, themesReadAt: theme.readAt, seal: theme.seal };
  }
  return knowledgeDocumentIds.length ? { kind: "knowledge", topic, knowledgeDocumentIds } : { kind: "topic", topic };
}

export function toIdeas(raw: readonly RawIdea[], input: IdeaInput): PostIdea[] {
  return raw.map((idea) => ({ title: idea.title, angle: idea.angle, pillar: idea.pillar, source: ideaSource(idea, input) }));
}
