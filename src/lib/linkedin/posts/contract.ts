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
  scheduledAt: string | null;
  publishedAt: string | null;
  postUrl: string | null;
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
