/**
 * LinkedIn posts: the shapes and limits the API, the pages and the publish
 * path share (docs/linkedin-content/plan.md). Client-safe: no imports.
 */

export const POST_STATUSES = ["draft", "scheduled", "publishing", "published", "failed"] as const;
export type LinkedinPostStatus = (typeof POST_STATUSES)[number];

/** The list page's tabs and the statuses each shows. */
export const POST_TABS = [
  { value: "drafts", label: "Drafts", statuses: ["draft"] },
  { value: "scheduled", label: "Scheduled", statuses: ["scheduled"] },
  { value: "published", label: "Published", statuses: ["published", "publishing"] },
  { value: "failed", label: "Failed", statuses: ["failed"] },
] as const satisfies readonly { value: string; label: string; statuses: readonly LinkedinPostStatus[] }[];
export type PostTab = (typeof POST_TABS)[number]["value"];

export function postTab(value: string | null | undefined): (typeof POST_TABS)[number] {
  return POST_TABS.find((tab) => tab.value === value) ?? POST_TABS[0];
}

/** Statuses a person may still edit or delete. Published posts are read-only. */
export const EDITABLE_STATUSES: readonly LinkedinPostStatus[] = ["draft", "scheduled", "failed"];

/** Statuses the publish path may claim. */
export const PUBLISHABLE_STATUSES: readonly LinkedinPostStatus[] = ["draft", "scheduled"];

/** LinkedIn's limit on a post's text, in characters. */
export const MAX_POST_LENGTH = 3000;

/** Images per post in v1 (LinkedIn allows more; raise once checked on a real account). */
export const MAX_POST_IMAGES = 4;

/** Bytes per image. LinkedIn's own ceiling is higher; this keeps uploads and the publish call small. */
export const MAX_POST_IMAGE_BYTES = 8 * 1024 * 1024;

export const POST_IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** What the post's `attachments` holds: R2 objects, never URLs. */
export type LinkedinPostAttachment = {
  /** linkedin-posts/<post id>/<uuid>.<ext> */
  key: string;
  fileName: string;
  contentType: string;
  bytes: number;
};

/** How a post was written. Phase 1 writes only `blank`. */
export type LinkedinPostSource = {
  kind: "blank" | "topic" | "knowledge" | "conversations";
  topic?: string;
  knowledgeDocumentIds?: string[];
  themeSummary?: string;
};

/** The AI draft a post started from (Phase 2). */
export type LinkedinPostGeneration = {
  model: string;
  prompts: { name: string; version: number | null }[];
};

/** `published_by` for a post the scheduler published (Phase 3). */
export const SYSTEM_PUBLISHER = "system";

/** The message on a post whose publish ended uncertain. */
export const UNCERTAIN_PUBLISH_ERROR = "This may have been posted — check LinkedIn before trying again.";

// ------------------------------------------------------------ scheduling (Phase 3)

/** A post is scheduled at least this far ahead. */
export const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;

/** And at most this far: a year. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

/** A scheduled post more than this late fails ("missed its time") instead of going out. */
export const MAX_SCHEDULE_LATENESS_MS = 6 * 60 * 60 * 1000;

/** The composer warns when another post on the same account is this close. A warning, not a rule. */
export const NEARBY_POST_WARNING_MS = 4 * 60 * 60 * 1000;

/** The start of the error on a scheduled post the job failed for being too late. */
export const MISSED_TIME_ERROR = "This post missed its time";

/** One of the account's other posts, for the composer's "another post within 4 hours" warning. */
export type PostTime = { id: string; at: string; status: "scheduled" | "published" | "publishing" };

export type LinkedinPostAccount = {
  id: string;
  name: string | null;
  username: string;
  profilePictureUrl: string | null;
  status: "CONNECTED" | "DISCONNECTED";
};

/** A post as the API and the pages see it. */
export type LinkedinPostView = {
  id: string;
  status: LinkedinPostStatus;
  body: string;
  /** `imageId` names the image in /api/linkedin/posts/<id>/images/<imageId>. */
  attachments: (LinkedinPostAttachment & { imageId: string })[];
  account: LinkedinPostAccount | null;
  /** How it was written; null on rows from before Phase 2 recorded it. */
  source: LinkedinPostSource | null;
  /** The AI draft it started from, if any. */
  generation: LinkedinPostGeneration | null;
  scheduledAt: string | null;
  /** For a scheduled post: why it is not going out at its time, if anything is in the way. */
  waiting: string | null;
  publishedAt: string | null;
  postUrl: string | null;
  /** Why it failed; on a scheduled post, a note from the scheduler (moved to the next day). */
  error: string | null;
  createdBy: { id: string; name: string | null } | null;
  publishedBy: { id: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The uuid part of an attachment key, what the image routes take. Not the
 * `<uuid>.<ext>` file name: src/proxy.ts lets any path ending in an image
 * extension through untouched (static files), demo read-only guard included.
 */
export function attachmentImageId(key: string): string {
  const file = key.slice(key.lastIndexOf("/") + 1);
  return file.replace(/\.[a-z]+$/, "");
}

/**
 * The part of a post LinkedIn shows in the feed before "…see more": about
 * three lines, or fewer when the text is long. LinkedIn does not publish the
 * exact rule and it differs between desktop and mobile; this is the common
 * cut (at most 3 lines and about 210 characters), close enough to show the
 * writer where the hook has to land.
 */
export const PREVIEW_MAX_LINES = 3;
export const PREVIEW_MAX_CHARS = 210;

export function feedPreview(body: string): { shown: string; truncated: boolean } {
  const text = body.replace(/\s+$/, "");
  const lines = text.split("\n");
  let shown = lines.slice(0, PREVIEW_MAX_LINES).join("\n");
  let truncated = lines.length > PREVIEW_MAX_LINES;
  if (shown.length > PREVIEW_MAX_CHARS) {
    const cut = shown.slice(0, PREVIEW_MAX_CHARS);
    const space = cut.lastIndexOf(" ");
    shown = (space > PREVIEW_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).replace(/\s+$/, "");
    truncated = true;
  }
  return { shown, truncated };
}

/** The first non-empty line, for lists. */
export function firstLine(body: string): string {
  return body.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

// ------------------------------------------------------------ AI drafts (Phase 2)

/** Drafts one "Write with AI" proposes; the rep picks one. A rewrite gives one. */
export const POST_DRAFT_VARIANTS = 3;

/** The rep's topic: "a line or two". */
export const MAX_TOPIC_LENGTH = 500;

/** A rewrite's instruction ("shorter", "lead with the number", "less salesy"). */
export const MAX_REWRITE_INSTRUCTION_LENGTH = 500;

/** Knowledge documents picked by hand for one draft. Each is read whole. */
export const MAX_PICKED_KNOWLEDGE = 20;

/**
 * The Knowledge tag that lets a document reach a post. Knowledge is written
 * for private replies and can hold pricing or client names, so only documents
 * tagged `public` (and marked "always include") are added on their own; a
 * document picked by hand without it is used, with a warning in the composer.
 */
export const PUBLIC_KNOWLEDGE_TAG = "public";

/** Kinds listed first in the composer's Knowledge picker: what posts are most often made of. */
export const POST_KNOWLEDGE_KINDS_FIRST: readonly string[] = ["case_study", "objection", "faq"];

export const KNOWLEDGE_KIND_LABELS: Readonly<Record<string, string>> = {
  case_study: "Case study",
  objection: "Objection",
  faq: "FAQ",
  company: "Company",
  product: "Product",
  pricing: "Pricing",
  scheduling: "Scheduling",
  custom: "Custom",
};

/** A Knowledge document as the composer lists it. */
export type PostKnowledgeOption = {
  id: string;
  title: string;
  kind: string;
  alwaysInclude: boolean;
  /** Tagged `public`. */
  isPublic: boolean;
  chars: number;
};

/** Case studies, objections and FAQs first, then the rest; by title within each. */
export function sortKnowledgeForPosts<T extends { kind: string; title: string }>(documents: readonly T[]): T[] {
  const rank = (kind: string) => {
    const index = POST_KNOWLEDGE_KINDS_FIRST.indexOf(kind);
    return index === -1 ? POST_KNOWLEDGE_KINDS_FIRST.length : index;
  };
  return [...documents].sort((a, b) => rank(a.kind) - rank(b.kind) || a.title.localeCompare(b.title));
}

/** Added to every draft without being picked: always include, and tagged public. */
export function isAlwaysAddedKnowledge(document: { alwaysInclude: boolean; isPublic: boolean }): boolean {
  return document.alwaysInclude && document.isPublic;
}

/** The prompts a post's `generation` may name (src/lib/prompts/linkedin.ts). */
export const POST_PROMPT_NAMES: readonly string[] = [
  "linkedin/post-system",
  "linkedin/post-user",
  "linkedin/post-rewrite",
  "linkedin/post-tool",
];

/** How the author's past posts were read for a draft. */
export type PostVoiceStatus = "read" | "none" | "unavailable";

/** What /api/linkedin/posts/generate and /rewrite answer. */
export type PostDraftsResponse = {
  variants: { body: string }[];
  /** What to record on the post when the rep uses a variant. */
  source: LinkedinPostSource;
  generation: LinkedinPostGeneration;
  voice: { status: PostVoiceStatus; pastPosts: number };
};

/** Hashtags in a post's text (`#word`, not `#1`). */
export function countHashtags(text: string): number {
  return text.match(/(^|[^\p{L}\p{N}_&#/])#[\p{L}_][\p{L}\p{N}_]*/gu)?.length ?? 0;
}
