/**
 * Request parsing for /api/linkedin/posts/*: pure, so the routes stay thin
 * and the rules are tested (requests.test.ts). Client-safe.
 */
import {
  MAX_PICKED_KNOWLEDGE,
  MAX_POST_IMAGE_BYTES,
  MAX_POST_IMAGES,
  MAX_POST_LENGTH,
  MAX_REWRITE_INSTRUCTION_LENGTH,
  MAX_THEME_SUMMARY_LENGTH,
  MAX_THEME_TITLE_LENGTH,
  MAX_TOPIC_LENGTH,
  THEME_KINDS,
  POST_IMAGE_TYPES,
  POST_PROMPT_NAMES,
  POST_STATUSES,
  type LinkedinPostGeneration,
  type LinkedinPostSource,
  type LinkedinPostStatus,
  type PostTheme,
  type ThemeKind,
} from "./contract";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPostId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export type ListQuery = {
  statuses: LinkedinPostStatus[] | null;
  linkedinAccountId: string | null;
  page: number;
  pageSize: number;
};

/** `?status=draft,failed&account=<id>&page=1&pageSize=25`. */
export function parseListQuery(params: URLSearchParams): Parsed<ListQuery> {
  let statuses: LinkedinPostStatus[] | null = null;
  const rawStatus = params.get("status");
  if (rawStatus) {
    const parts = [...new Set(rawStatus.split(",").map((part) => part.trim()).filter(Boolean))];
    const unknown = parts.find((part) => !(POST_STATUSES as readonly string[]).includes(part));
    if (unknown) return fail(`Unknown status: ${unknown}`);
    statuses = parts as LinkedinPostStatus[];
  }
  const account = params.get("account")?.trim() || null;
  if (account && account.length > 64) return fail("Unknown account");

  const page = params.get("page") ? Number(params.get("page")) : 1;
  if (!Number.isInteger(page) || page < 1) return fail("page must be a whole number from 1");
  const pageSize = params.get("pageSize") ? Number(params.get("pageSize")) : DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return fail(`pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}`);
  }
  return ok({ statuses, linkedinAccountId: account, page, pageSize });
}

function readBody(value: unknown): Parsed<string> {
  if (typeof value !== "string") return fail("body must be text");
  // LinkedIn keeps line breaks; normalise Windows ones so the count matches what is posted.
  const body = value.replace(/\r\n?/g, "\n");
  if (body.length > MAX_POST_LENGTH) return fail(`A post can be at most ${MAX_POST_LENGTH.toLocaleString("en-US")} characters.`);
  return ok(body);
}

function readAccountId(value: unknown): Parsed<string> {
  if (typeof value !== "string" || !value.trim() || value.length > 64) return fail("Choose a LinkedIn account");
  return ok(value.trim());
}

function asObject(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

/** How a post was written, when the rep uses an AI draft. */
export type PostOrigin = { source: LinkedinPostSource; generation: LinkedinPostGeneration | null };

function readKnowledgeIds(value: unknown): Parsed<string[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value) || value.length > MAX_PICKED_KNOWLEDGE * 2) return fail("knowledgeDocumentIds must be a list of Knowledge document ids");
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) return fail("knowledgeDocumentIds must be a list of Knowledge document ids");
    const lower = id.toLowerCase();
    if (!ids.includes(lower)) ids.push(lower);
  }
  return ok(ids);
}

function readTopic(value: unknown): Parsed<string | null> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== "string") return fail("topic must be text");
  const topic = value.replace(/\r\n?/g, "\n").trim();
  if (topic.length > MAX_TOPIC_LENGTH) return fail(`A topic can be at most ${MAX_TOPIC_LENGTH} characters.`);
  return ok(topic || null);
}

const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const SEAL_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

/** The sealed part of a theme: what the server signed. Its seal is checked by the server (themeSeal.server.ts). */
type SealedTheme = { title: string; summary: string; readAt: string; seal: string };

function readSealedTheme(object: Record<string, unknown>, names: { title: string; summary: string; readAt: string }): Parsed<SealedTheme> {
  const title = object[names.title];
  const summary = object[names.summary];
  const readAt = object[names.readAt];
  if (typeof title !== "string" || !title.trim() || title.length > MAX_THEME_TITLE_LENGTH) return fail("The theme has no title");
  if (typeof summary !== "string" || !summary.trim() || summary.length > MAX_THEME_SUMMARY_LENGTH) return fail("The theme has no summary");
  if (typeof readAt !== "string" || !ISO_SECONDS.test(readAt) || Number.isNaN(Date.parse(readAt))) return fail("The theme has no time it was read");
  if (typeof object.seal !== "string" || !SEAL_PATTERN.test(object.seal)) return fail("The theme is not one AgentSDR found. Find themes again.");
  // Exactly as sealed: no trimming, or the seal would not match.
  return ok({ title, summary, readAt, seal: object.seal });
}

/**
 * A prospects' theme as /themes answered it, sent back to /generate or
 * /rewrite: `{ title, kind, summary, mentions, readAt, seal }`.
 */
export function parseTheme(value: unknown): Parsed<PostTheme> {
  const object = asObject(value);
  if (!object) return fail("theme must be an object");
  const unknown = Object.keys(object).filter((key) => !["title", "kind", "summary", "mentions", "readAt", "seal"].includes(key));
  if (unknown.length) return fail(`theme has unknown field(s): ${unknown.join(", ")}`);
  const sealed = readSealedTheme(object, { title: "title", summary: "summary", readAt: "readAt" });
  if (!sealed.ok) return sealed;
  const kind = (THEME_KINDS as readonly string[]).includes(object.kind as string) ? (object.kind as ThemeKind) : "other";
  const mentions = typeof object.mentions === "number" && Number.isInteger(object.mentions) && object.mentions > 0 ? object.mentions : 1;
  return ok({ ...sealed.value, kind, mentions });
}

/**
 * `source` as the composer sends it back from a generate or rewrite answer.
 * `conversations` (Phase 4) must carry the server's seal over its theme,
 * which the server checks before saving: the browser can only hand back a
 * source the server wrote.
 */
export function parseSource(value: unknown): Parsed<LinkedinPostSource> {
  const object = asObject(value);
  if (!object) return fail("source must be an object");
  const allowed = object.kind === "conversations"
    ? ["kind", "topic", "knowledgeDocumentIds", "themeTitle", "themeSummary", "themesReadAt", "seal"]
    : ["kind", "topic", "knowledgeDocumentIds"];
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) return fail(`source has unknown field(s): ${unknown.join(", ")}`);
  if (object.kind !== "blank" && object.kind !== "topic" && object.kind !== "knowledge" && object.kind !== "conversations") {
    return fail("source.kind must be blank, topic, knowledge or conversations");
  }
  const topic = readTopic(object.topic);
  if (!topic.ok) return topic;
  const ids = readKnowledgeIds(object.knowledgeDocumentIds);
  if (!ids.ok) return ids;
  if (object.kind === "knowledge" && ids.value.length === 0) return fail("A Knowledge source names its documents");
  const base = { ...(topic.value ? { topic: topic.value } : {}), ...(ids.value.length ? { knowledgeDocumentIds: ids.value } : {}) };
  if (object.kind === "conversations") {
    const theme = readSealedTheme(object, { title: "themeTitle", summary: "themeSummary", readAt: "themesReadAt" });
    if (!theme.ok) return theme;
    return ok({ kind: "conversations", ...base, themeTitle: theme.value.title, themeSummary: theme.value.summary, themesReadAt: theme.value.readAt, seal: theme.value.seal });
  }
  return ok({ kind: object.kind, ...base });
}

/** `generation`: the model and the prompt versions of the AI draft a post started from. */
export function parseGeneration(value: unknown): Parsed<LinkedinPostGeneration | null> {
  if (value === null || value === undefined) return ok(null);
  const object = asObject(value);
  if (!object) return fail("generation must be an object");
  if (Object.keys(object).some((key) => key !== "model" && key !== "prompts")) return fail("generation has unknown fields");
  if (typeof object.model !== "string" || !object.model.trim() || object.model.length > 200) return fail("generation.model must be the model's id");
  if (!Array.isArray(object.prompts) || object.prompts.length > POST_PROMPT_NAMES.length) return fail("generation.prompts must list the prompts used");
  const prompts: LinkedinPostGeneration["prompts"] = [];
  for (const prompt of object.prompts) {
    const entry = asObject(prompt);
    if (!entry || typeof entry.name !== "string" || !POST_PROMPT_NAMES.includes(entry.name)) return fail("generation.prompts names an unknown prompt");
    const version = entry.version;
    if (version !== null && (typeof version !== "number" || !Number.isInteger(version) || version < 1)) return fail("generation.prompts has an invalid version");
    prompts.push({ name: entry.name, version });
  }
  return ok({ model: object.model.trim(), prompts });
}

function readOrigin(object: Record<string, unknown>): Parsed<PostOrigin | undefined> {
  if (object.source === undefined) {
    return object.generation === undefined ? ok(undefined) : fail("generation is saved with its source");
  }
  const source = parseSource(object.source);
  if (!source.ok) return source;
  const generation = parseGeneration(object.generation);
  if (!generation.ok) return generation;
  return ok({ source: source.value, generation: generation.value });
}

export type CreatePostInput = { linkedinAccountId: string; body: string; origin?: PostOrigin };

/** POST / — `{ linkedinAccountId, body?, source?, generation? }`. A draft may be empty. */
export function parseCreatePost(input: unknown): Parsed<CreatePostInput> {
  const object = asObject(input);
  if (!object) return fail("Expected a JSON object");
  const account = readAccountId(object.linkedinAccountId);
  if (!account.ok) return account;
  const body = readBody(object.body ?? "");
  if (!body.ok) return body;
  const origin = readOrigin(object);
  if (!origin.ok) return origin;
  return ok({ linkedinAccountId: account.value, body: body.value, ...(origin.value ? { origin: origin.value } : {}) });
}

export type UpdatePostInput = { linkedinAccountId?: string; body?: string; origin?: PostOrigin };

/** PATCH /[id] — any of `{ linkedinAccountId, body, source (+ generation) }`, at least one. */
export function parseUpdatePost(input: unknown): Parsed<UpdatePostInput> {
  const object = asObject(input);
  if (!object) return fail("Expected a JSON object");
  const update: UpdatePostInput = {};
  if (object.linkedinAccountId !== undefined) {
    const account = readAccountId(object.linkedinAccountId);
    if (!account.ok) return account;
    update.linkedinAccountId = account.value;
  }
  if (object.body !== undefined) {
    const body = readBody(object.body);
    if (!body.ok) return body;
    update.body = body.value;
  }
  const origin = readOrigin(object);
  if (!origin.ok) return origin;
  if (origin.value) update.origin = origin.value;
  if (update.linkedinAccountId === undefined && update.body === undefined && !update.origin) return fail("Nothing to change");
  return ok(update);
}

export type GenerateDraftsInput = {
  linkedinAccountId: string;
  topic: string | null;
  knowledgeDocumentIds: string[];
  /** A prospects' theme to write from (Phase 4); its seal is checked by the server. */
  theme?: PostTheme;
};

function readDraftSources(object: Record<string, unknown>): Parsed<GenerateDraftsInput> {
  const account = readAccountId(object.linkedinAccountId);
  if (!account.ok) return account;
  const topic = readTopic(object.topic);
  if (!topic.ok) return topic;
  const ids = readKnowledgeIds(object.knowledgeDocumentIds);
  if (!ids.ok) return ids;
  if (ids.value.length > MAX_PICKED_KNOWLEDGE) return fail(`Choose at most ${MAX_PICKED_KNOWLEDGE} Knowledge documents.`);
  let theme: PostTheme | undefined;
  if (object.theme !== undefined && object.theme !== null) {
    const parsed = parseTheme(object.theme);
    if (!parsed.ok) return parsed;
    theme = parsed.value;
  }
  return ok({ linkedinAccountId: account.value, topic: topic.value, knowledgeDocumentIds: ids.value, ...(theme ? { theme } : {}) });
}

/** POST /generate — `{ linkedinAccountId, topic?, knowledgeDocumentIds?, theme? }`, a topic, a theme or a document at least. */
export function parseGenerateDrafts(input: unknown): Parsed<GenerateDraftsInput> {
  const object = asObject(input);
  if (!object) return fail("Expected a JSON object");
  const sources = readDraftSources(object);
  if (!sources.ok) return sources;
  if (!sources.value.topic && !sources.value.theme && sources.value.knowledgeDocumentIds.length === 0) {
    return fail("Write a topic, pick a theme or choose a Knowledge document.");
  }
  return sources;
}

export type RewriteDraftInput = GenerateDraftsInput & { body: string; instruction: string };

/** POST /rewrite — `{ linkedinAccountId, body, instruction, topic?, knowledgeDocumentIds?, theme? }`. */
export function parseRewriteDraft(input: unknown): Parsed<RewriteDraftInput> {
  const object = asObject(input);
  if (!object) return fail("Expected a JSON object");
  const sources = readDraftSources(object);
  if (!sources.ok) return sources;
  const body = readBody(object.body);
  if (!body.ok) return body;
  if (!body.value.trim()) return fail("Write something first, then ask for a rewrite.");
  if (typeof object.instruction !== "string" || !object.instruction.trim()) return fail("Say how to rewrite it, such as “shorter”.");
  const instruction = object.instruction.replace(/\r\n?/g, "\n").trim();
  if (instruction.length > MAX_REWRITE_INSTRUCTION_LENGTH) return fail(`An instruction can be at most ${MAX_REWRITE_INSTRUCTION_LENGTH} characters.`);
  return ok({ ...sources.value, body: body.value, instruction });
}

/** What the first bytes of a file say it is; null for anything but the four image types. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export type ImageUpload = { contentType: string; fileName: string; bytes: number };

/**
 * POST /[id]/images — one file. The type is taken from the file's own bytes
 * (the declared type must agree), so a renamed file cannot pass as an image.
 */
export function validateImageUpload(input: {
  declaredType: string;
  fileName: string;
  head: Uint8Array;
  size: number;
  existingCount: number;
}): Parsed<ImageUpload> {
  if (input.existingCount >= MAX_POST_IMAGES) return fail(`A post can have at most ${MAX_POST_IMAGES} images.`);
  if (input.size <= 0) return fail("The file is empty.");
  if (input.size > MAX_POST_IMAGE_BYTES) return fail(`An image can be at most ${MAX_POST_IMAGE_BYTES / (1024 * 1024)} MB.`);
  const sniffed = sniffImageType(input.head);
  if (!sniffed) return fail("Use a JPG, PNG, WebP or GIF image.");
  const declared = input.declaredType.toLowerCase().replace("image/jpg", "image/jpeg");
  if (declared && declared !== "application/octet-stream" && declared !== sniffed) {
    return fail("The file's type does not match its contents.");
  }
  const fileName = (input.fileName || `image.${POST_IMAGE_TYPES[sniffed]}`).replace(/[\u0000-\u001f"\\/]/g, "_").slice(0, 120);
  return ok({ contentType: sniffed, fileName, bytes: input.size });
}

/** GET / DELETE /[id]/images/[imageId] — the uuid part of the image's key. */
export function isImageId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export type SchedulePostInput = { date: string; time: string };

/**
 * POST /[id]/schedule — `{ date: "YYYY-MM-DD", time: "HH:MM" }`, read in the
 * organization's time zone by the server (scheduleRules.scheduleInstant), so
 * the browser's own zone never matters.
 */
export function parseSchedulePost(input: unknown): Parsed<SchedulePostInput> {
  const object = asObject(input);
  if (!object) return fail("Expected a JSON object");
  if (typeof object.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(object.date)) return fail("Choose a date");
  if (typeof object.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(object.time)) return fail("Choose a time");
  return ok({ date: object.date, time: object.time });
}
