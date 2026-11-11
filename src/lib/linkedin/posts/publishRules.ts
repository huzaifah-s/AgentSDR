/**
 * The publish path's decisions, pure so they can be tested without a
 * database or Unipile (publish.ts runs them). Client-safe.
 */
import {
  MAX_POST_IMAGES,
  MAX_POST_LENGTH,
  PUBLISHABLE_STATUSES,
  UNCERTAIN_PUBLISH_ERROR,
  type LinkedinPostStatus,
} from "./contract";

/** A post in `publishing` this long is taken to be lost with its process. */
export const STALE_PUBLISHING_MS = 5 * 60 * 1000;

export type PublishRefusal = {
  /** HTTP status the route answers with. */
  status: 400 | 404 | 409 | 429;
  message: string;
  /**
   * What the scheduled-posts job acts on: `daily-limit` moves the post to the
   * next day, `account` leaves it waiting, `not-due` means a person changed it
   * since the job found it. Absent for refusals the job just records.
   */
  reason?: "daily-limit" | "account" | "not-due";
};

/**
 * Whether a post may be claimed for publishing now. Null means yes. Nothing
 * here changes the post: a refusal leaves it as it was.
 */
export function publishRefusal(input: {
  status: LinkedinPostStatus;
  body: string;
  attachmentCount: number;
  account: { status: "CONNECTED" | "DISCONNECTED"; name: string } | null;
  publishedToday: number;
  postsPerDay: number;
}): PublishRefusal | null {
  if (!PUBLISHABLE_STATUSES.includes(input.status)) {
    if (input.status === "published") return { status: 409, message: "This post is already published." };
    if (input.status === "publishing") return { status: 409, message: "This post is being published." };
    return { status: 409, message: "Save this post as a draft before publishing it again." };
  }
  if (!input.body.trim()) return { status: 400, message: "Write something before publishing." };
  if (input.body.length > MAX_POST_LENGTH) {
    return { status: 400, message: `A post can be at most ${MAX_POST_LENGTH.toLocaleString("en-US")} characters.` };
  }
  if (input.attachmentCount > MAX_POST_IMAGES) return { status: 400, message: `A post can have at most ${MAX_POST_IMAGES} images.` };
  if (!input.account) return { status: 409, message: "This post's LinkedIn account is no longer connected to your organization.", reason: "account" };
  if (input.account.status !== "CONNECTED") {
    return { status: 409, message: `${input.account.name}'s LinkedIn account is disconnected. Reconnect it in Settings → LinkedIn accounts.`, reason: "account" };
  }
  if (input.publishedToday >= input.postsPerDay) {
    const limit = input.postsPerDay === 1 ? "1 post" : `${input.postsPerDay} posts`;
    return {
      status: 429,
      message: `${input.account.name} has already published ${limit} today, the limit in Settings → LinkedIn → Sending rules.`,
      reason: "daily-limit",
    };
  }
  return null;
}

/**
 * Whether a refusal only makes the post wait (the daily limit, a
 * disconnected account) rather than saying something is wrong with it. The
 * leak guard is checked before these: a post that names a prospect will not
 * pass by waiting, so the rep should hear that first, and a scheduled one
 * should fail now rather than wait a day and fail then.
 */
export function onlyWaits(refusal: PublishRefusal | null): boolean {
  return refusal?.reason === "daily-limit" || refusal?.reason === "account";
}

/** What a failed Unipile call leaves on the post. */
export function failureError(kind: "refused" | "uncertain", detail: string): string {
  if (kind === "uncertain") return detail ? `${UNCERTAIN_PUBLISH_ERROR} (${detail})` : UNCERTAIN_PUBLISH_ERROR;
  return detail ? `LinkedIn refused the post: ${detail}` : "LinkedIn refused the post.";
}

/**
 * The public link for a published post, from the id Unipile returns.
 *
 * Provisional until checked on a real account (docs/linkedin-content/plan.md):
 * Unipile is expected to return the activity id, either bare digits or a
 * `urn:li:…` URN, and LinkedIn shows a post at /feed/update/<urn>/. Anything
 * else gets no link rather than a wrong one.
 */
export function postUrlFor(providerPostId: string | null): string | null {
  if (!providerPostId) return null;
  const id = providerPostId.trim();
  if (/^\d+$/.test(id)) return `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;
  if (/^urn:li:(activity|share|ugcPost):[A-Za-z0-9_-]+$/.test(id)) return `https://www.linkedin.com/feed/update/${id}/`;
  return null;
}

/** Whether a post stuck in `publishing` should be failed as uncertain. */
export function isStalePublishing(status: LinkedinPostStatus, claimedAt: Date, now: Date): boolean {
  return status === "publishing" && now.getTime() - claimedAt.getTime() > STALE_PUBLISHING_MS;
}
