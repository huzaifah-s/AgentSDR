import "server-only";

import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { requirePlatformCredentials } from "@/lib/platform/credentials";
import { latestDailySlot } from "@/lib/scheduler/slots";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { createLinkedinPost, UnipilePostError, type PostImage } from "@/services/unipile.posts";
import { UNCERTAIN_PUBLISH_ERROR, type LinkedinPostStatus } from "./contract";
import { conversationsLeakMessage } from "./leakCheck.server";
import { failureError, onlyWaits, postUrlFor, publishRefusal, STALE_PUBLISHING_MS, type PublishRefusal } from "./publishRules";
import { linkedinPosts } from "./schema";
import { getPostImageBytes } from "./storage";

/**
 * Publishing one post: claim it, call Unipile once, settle it. Used by the
 * Publish now route, and by the scheduled-posts job in Phase 3.
 *
 * The rule that shapes all of it: a second copy of a post on someone's
 * profile is worse than a missing one. So the post is claimed
 * (`publishing`) before Unipile is called, nothing ever retries on its own,
 * and an answer we did not get (timeout, 5xx, dropped connection, a crash)
 * fails the post as "may have been posted" for a person to check.
 */

export class PostPublishRefusedError extends Error {
  constructor(readonly refusal: PublishRefusal) {
    super(refusal.message);
    this.name = "PostPublishRefusedError";
  }
}

export type PublishOutcome =
  | { status: "published"; providerPostId: string | null; postUrl: string | null }
  | { status: "failed"; error: string; uncertain: boolean };

/** When the organization's current day began (Settings → Organization). */
export async function organizationDayStart(now: Date): Promise<Date> {
  const general = await channelRules("general");
  return latestDailySlot(general.timeZone, general.dayStartsAt, now);
}

/**
 * What counts against an account's postsPerDay: posts published since the
 * day began, and any being published right now.
 */
export function countsTowardToday(dayStart: Date) {
  return and(
    inOrg(linkedinPosts),
    or(
      and(eq(linkedinPosts.status, "published"), gte(linkedinPosts.publishedAt, dayStart)),
      eq(linkedinPosts.status, "publishing"),
    ),
  );
}

type Claimed = {
  previousStatus: LinkedinPostStatus;
  body: string;
  attachments: { key: string; fileName: string; contentType: string }[];
  unipileAccountId: string;
};

/** Posts counted against today's limit, per account, for the composer. */
export async function publishedTodayByAccount(now: Date = new Date()): Promise<Record<string, number>> {
  const dayStart = await organizationDayStart(now);
  const rows = await db
    .select({ accountId: linkedinPosts.linkedinAccountId, n: sql<number>`count(*)::int` })
    .from(linkedinPosts)
    .where(countsTowardToday(dayStart))
    .groupBy(linkedinPosts.linkedinAccountId);
  return Object.fromEntries(rows.map((row) => [row.accountId, row.n]));
}

/**
 * Step 1: lock the post, check it may go out now, and mark it `publishing`.
 *
 * `scheduled` is the job's claim: the post must still be `scheduled` and due
 * (a person may have unscheduled or moved it since the job found it), and a
 * row someone else holds locked right now is skipped, not waited for.
 */
async function claim(postId: string, publishedBy: string, now: Date, scheduled: boolean): Promise<Claimed> {
  const { postsPerDay } = await channelRules("linkedin");
  const dayStart = await organizationDayStart(now);

  return db.transaction(async (tx) => {
    const select = tx
      .select()
      .from(linkedinPosts)
      .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)));
    const [post] = scheduled ? await select.for("update", { skipLocked: true }) : await select.for("update");
    if (!post) throw new PostPublishRefusedError({ status: 404, message: "Post not found" });
    if (scheduled && (post.status !== "scheduled" || !post.scheduledAt || post.scheduledAt > now)) {
      throw new PostPublishRefusedError({ status: 409, message: "This post is no longer due.", reason: "not-due" });
    }

    // One account's publishes go one at a time, so two posts cannot both
    // pass the daily limit by counting before either is claimed.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`linkedin-post:account:${post.linkedinAccountId}`}, 0))`);

    const [account] = await tx
      .select({ linkedinId: linkedInAccounts.linkedinId, status: linkedInAccounts.status, name: linkedInAccounts.name, username: linkedInAccounts.username })
      .from(linkedInAccounts)
      .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, post.linkedinAccountId)));

    const [{ n: publishedToday }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(linkedinPosts)
      .where(and(countsTowardToday(dayStart), eq(linkedinPosts.linkedinAccountId, post.linkedinAccountId)));

    const refusal = publishRefusal({
      status: post.status,
      body: post.body,
      attachmentCount: post.attachments.length,
      account: account ? { status: account.status, name: account.name || account.username } : null,
      publishedToday,
      postsPerDay,
    });
    if (refusal && !onlyWaits(refusal)) throw new PostPublishRefusedError(refusal);

    // The leak guard, once more on the text as it is now (Phase 4), before
    // the refusals that only wait (`onlyWaits`). The job records it as the
    // post's failure: it will not pass by waiting.
    const leak = await conversationsLeakMessage(post, tx);
    if (leak) throw new PostPublishRefusedError({ status: 409, message: leak });
    if (refusal) throw new PostPublishRefusedError(refusal);

    await tx
      .update(linkedinPosts)
      .set({ status: "publishing", error: null, publishedBy, updatedAt: now })
      .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)));

    return {
      previousStatus: post.status,
      body: post.body,
      attachments: post.attachments,
      unipileAccountId: account!.linkedinId,
    };
  });
}

/** Settle a claimed post. Only a post still `publishing` changes. */
async function settle(postId: string, values: Partial<typeof linkedinPosts.$inferInsert>): Promise<void> {
  await db
    .update(linkedinPosts)
    .set({ ...values, updatedAt: new Date() })
    .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId), eq(linkedinPosts.status, "publishing")));
}

/**
 * Publish a post now, in the organization in scope (`scheduled`: the job
 * publishing a due scheduled post, see claim). Throws
 * PostPublishRefusedError (nothing changed) when it may not go out, and
 * PlatformNotConnectedError when Unipile is not connected. Otherwise returns
 * how it ended; a failure is recorded on the post.
 */
export async function publishPost(
  postId: string,
  { publishedBy, now = new Date(), scheduled = false }: { publishedBy: string; now?: Date; scheduled?: boolean },
): Promise<PublishOutcome> {
  // Before the claim, so a missing integration leaves the post untouched.
  await requirePlatformCredentials("unipile");
  const claimed = await claim(postId, publishedBy, now, scheduled);

  // Step 2: the images. Nothing has gone to LinkedIn yet, so a failure here
  // puts the post back as it was, with the reason.
  let images: PostImage[];
  try {
    images = await Promise.all(
      claimed.attachments.map(async (attachment) => ({
        bytes: await getPostImageBytes(attachment.key),
        contentType: attachment.contentType,
        fileName: attachment.fileName,
      })),
    );
  } catch (error) {
    const message = `Could not read this post's images: ${error instanceof Error ? error.message : String(error)}`;
    await settle(postId, { status: claimed.previousStatus, error: message, publishedBy: null });
    return { status: "failed", error: message, uncertain: false };
  }

  // Step 3: one call to Unipile, never repeated.
  try {
    const { postId: providerPostId } = await createLinkedinPost({ accountId: claimed.unipileAccountId, text: claimed.body, images });
    const postUrl = postUrlFor(providerPostId);
    await settle(postId, { status: "published", publishedAt: new Date(), providerPostId, postUrl, error: null });
    return { status: "published", providerPostId, postUrl };
  } catch (error) {
    const kind = error instanceof UnipilePostError ? error.kind : "uncertain";
    const detail = error instanceof Error ? error.message : String(error);
    const message = failureError(kind, detail);
    await settle(postId, { status: "failed", error: message });
    if (!(error instanceof UnipilePostError)) console.error("[linkedin/posts] publish failed unexpectedly", { postId, error });
    return { status: "failed", error: message, uncertain: kind === "uncertain" };
  }
}

/**
 * Fail posts left in `publishing` for more than five minutes (a process that
 * died between the claim and the settle), in the organization in scope. They
 * may have gone out, so they fail as uncertain and are never retried.
 * Returns how many were failed.
 */
export async function failStalePublishingPosts(now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(linkedinPosts)
    .set({ status: "failed", error: UNCERTAIN_PUBLISH_ERROR, updatedAt: now })
    .where(
      and(
        inOrg(linkedinPosts),
        eq(linkedinPosts.status, "publishing"),
        lt(linkedinPosts.updatedAt, new Date(now.getTime() - STALE_PUBLISHING_MS)),
      ),
    )
    .returning({ id: linkedinPosts.id });
  return rows.length;
}

/**
 * The same across every organization, for the platform job (Phase 3): finds
 * the organizations with a stale post and fails them in each one's scope.
 */
export async function failStalePublishingPostsEverywhere(now: Date = new Date()): Promise<number> {
  const orgs = await db
    .selectDistinct({ organizationId: linkedinPosts.organizationId })
    .from(linkedinPosts)
    .where(
      and(
        eq(linkedinPosts.status, "publishing"),
        lt(linkedinPosts.updatedAt, new Date(now.getTime() - STALE_PUBLISHING_MS)),
      ),
    );
  let failed = 0;
  for (const { organizationId } of orgs) {
    failed += await runInOrganization(organizationId, () => failStalePublishingPosts(now));
  }
  return failed;
}
