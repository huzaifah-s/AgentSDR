/**
 * Prospects' themes (docs/linkedin-content/plan.md, Phase 4), the pure half:
 * what of a reply or a call is read, the prompt that groups them, and the
 * check of the model's answer. themes.server.ts reads the messages and makes
 * the call. Client-safe apart from the prompt copies it reads.
 */
import type { PromptName } from "@/lib/prompts/registry";
import { fillPrompt } from "@/lib/prompts/template";
import { codeTemplates, type PromptTemplates } from "@/lib/prompts/templates";
import {
  MAX_THEME_SUMMARY_LENGTH,
  MAX_THEME_TITLE_LENGTH,
  MAX_THEMES,
  MIN_THEMES,
  THEME_KINDS,
  type ThemeKind,
} from "./contract";

export const THEME_PROMPTS = ["linkedin/post-themes", "linkedin/post-themes-user", "linkedin/post-themes-tool"] as const satisfies readonly PromptName[];
type ThemePromptName = (typeof THEME_PROMPTS)[number];
export type ThemeTemplates = PromptTemplates<ThemePromptName>;
const CODE_TEMPLATES: ThemeTemplates = codeTemplates(THEME_PROMPTS);

/** Characters of one message or call read for themes: enough for the point, not a whole thread. */
export const MAX_THEME_ITEM_CHARS = 1500;

export type ThemeSourceChannel = "email" | "linkedin" | "whatsapp" | "call";

/** One reply or call as the themes call sees it: redacted text, no ids. */
export type ThemeSourceItem = { channel: ThemeSourceChannel; at: string; text: string };

/** A theme as the model gives it, before the leak guard and the seal. */
export type FoundTheme = { title: string; kind: ThemeKind; summary: string; mentions: number };

/**
 * A reply's own words: quoted earlier messages (lines starting ">", and
 * everything from "On … wrote:" or an "Original Message" / "From:" header
 * down) are ours or older, so they are cut. Whitespace runs are tidied.
 */
export function replyText(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed)) break;
    if (/^On\b.{0,200}\bwrote:$/i.test(trimmed)) break;
    if (/^From:\s.+/i.test(trimmed) && kept.some((kept) => kept.trim())) break;
    if (trimmed.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** The lead's side of a call transcript, in order. */
export function leadSideOfCall(utterances: readonly { speaker: string; text: string }[]): string {
  return utterances
    .filter((utterance) => utterance.speaker === "lead")
    .map((utterance) => utterance.text.trim())
    .filter(Boolean)
    .join("\n");
}

export function clipItem(text: string): string {
  return text.length > MAX_THEME_ITEM_CHARS ? `${text.slice(0, MAX_THEME_ITEM_CHARS).trimEnd()}…` : text;
}

/** 3–6 themes from enough messages; from fewer than six, one to three. */
export function themeRange(items: number): { min: number; max: number } {
  if (items >= MAX_THEMES) return { min: MIN_THEMES, max: MAX_THEMES };
  return { min: 1, max: Math.max(1, Math.min(MIN_THEMES, items)) };
}

export function themesJsonSchema(range: { min: number; max: number }): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["themes"],
    properties: {
      themes: {
        type: "array",
        minItems: range.min,
        maxItems: range.max,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "kind", "summary", "mentions"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: MAX_THEME_TITLE_LENGTH },
            kind: { type: "string", enum: [...THEME_KINDS] },
            summary: { type: "string", minLength: 1, maxLength: MAX_THEME_SUMMARY_LENGTH },
            mentions: { type: "integer", minimum: 1 },
          },
        },
      },
    },
  };
}

export type ThemeRules = { min: number; max: number; items: number };

export type BuiltThemesPrompt = {
  systemPrompt: string;
  userPrompt: string;
  toolDescription: string;
  jsonSchema: Record<string, unknown>;
  rules: ThemeRules;
};

/** The themes prompt over the (already redacted) items. Pure. */
export function buildThemesPrompt(items: readonly ThemeSourceItem[], templates: ThemeTemplates = CODE_TEMPLATES): BuiltThemesPrompt {
  if (!items.length) throw new Error("There are no messages to find themes in");
  const range = themeRange(items.length);
  return {
    systemPrompt: fillPrompt(templates["linkedin/post-themes"], { min_themes: range.min, max_themes: range.max }),
    userPrompt: fillPrompt(templates["linkedin/post-themes-user"], {
      count: items.length,
      messages_json: JSON.stringify(items.map((item) => ({ channel: item.channel, at: item.at, text: item.text })), null, 2),
    }),
    toolDescription: fillPrompt(templates["linkedin/post-themes-tool"], {}),
    jsonSchema: themesJsonSchema(range),
    rules: { ...range, items: items.length },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The model's answer, held to the schema and the range. Throws with the reason, so `accept` can retry. */
export function validateThemesOutput(raw: unknown, rules: ThemeRules): FoundTheme[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("The themes answer is malformed JSON");
    }
  }
  if (!isPlainObject(value) || !Array.isArray(value.themes)) throw new Error("The themes answer has no themes");
  const extra = Object.keys(value).filter((key) => key !== "themes");
  if (extra.length) throw new Error(`The themes answer has unknown field(s): ${extra.join(", ")}`);
  if (value.themes.length < rules.min || value.themes.length > rules.max) {
    throw new Error(`Give ${rules.min === rules.max ? rules.min : `${rules.min} to ${rules.max}`} themes, not ${value.themes.length}`);
  }
  const themes = value.themes.map((theme, index): FoundTheme => {
    if (!isPlainObject(theme)) throw new Error(`Theme ${index + 1} must be an object`);
    const unknown = Object.keys(theme).filter((key) => !["title", "kind", "summary", "mentions"].includes(key));
    if (unknown.length) throw new Error(`Theme ${index + 1} has unknown field(s): ${unknown.join(", ")}`);
    const title = typeof theme.title === "string" ? oneLine(theme.title) : "";
    const summary = typeof theme.summary === "string" ? theme.summary.replace(/\r\n?/g, "\n").trim() : "";
    if (!title || title.length > MAX_THEME_TITLE_LENGTH) throw new Error(`Theme ${index + 1} needs a title of at most ${MAX_THEME_TITLE_LENGTH} characters`);
    if (!summary || summary.length > MAX_THEME_SUMMARY_LENGTH) throw new Error(`Theme ${index + 1} needs a summary of at most ${MAX_THEME_SUMMARY_LENGTH} characters`);
    if (typeof theme.kind !== "string" || !(THEME_KINDS as readonly string[]).includes(theme.kind)) throw new Error(`Theme ${index + 1} has an unknown kind`);
    const mentions = theme.mentions;
    if (typeof mentions !== "number" || !Number.isInteger(mentions) || mentions < 1) throw new Error(`Theme ${index + 1} needs mentions, a whole number from 1`);
    if (mentions > rules.items) throw new Error(`Theme ${index + 1} says ${mentions} mentions; there are only ${rules.items} messages`);
    return { title, kind: theme.kind as ThemeKind, summary, mentions };
  });
  if (new Set(themes.map((theme) => theme.title.toLowerCase())).size !== themes.length) throw new Error("Two themes have the same title");
  // Most raised first.
  return themes.sort((a, b) => b.mentions - a.mentions);
}
