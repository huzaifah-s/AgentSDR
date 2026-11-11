import "server-only";

import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { SYSTEM_PUBLISHER } from "@/lib/linkedin/posts/contract";
import { failStalePublishingPosts, failStalePublishingPostsEverywhere, PostPublishRefusedError, publishPost } from "@/lib/linkedin/posts/publish";
import {
  missedTimeError,
  movedToNextDayNote,
  nextDayTime,
  nextOrganizationDayStart,
  planScheduledRun,
  scheduledWaitReason,
  type DuePost,
} from "@/lib/linkedin/posts/scheduleRules";
import { linkedinPosts } from "@/lib/linkedin/posts/schema";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { isPlatformConnected, isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";

/**
 * Scheduled LinkedIn posts (docs/linkedin-content/plan.md, Phase 3): the
 * platform job `linkedin-publish-posts`, every 2 minutes, and its endpoint
 * /api/linkedin/jobs/publish-posts.
 *
 * Each run finds the due posts across organizations, oldest first, and
 * (scheduleRules.planScheduledRun):
 *
 * - fails those more than 6 hours past their time ("missed its time"),
 * - publishes the oldest due post of each account, at most one per account,
 *   through the Phase 1 publish (claim → one Unipile call → settle; never
 *   retried; an uncertain answer fails the post as "may have been posted"),
 * - leaves the rest for the next runs.
 *
 * A post the daily limit holds back moves to the same time the next day,
 * with a note. Unipile not connected, or the account disconnected: the post
 * stays scheduled (the list shows why) until it is late. PAUSE_LINKEDIN_POSTS
 * stops the job; Publish now is unaffected.
 */

export type PublishScheduledSummary = {
  paused?: true;
  /** Posts left `publishing` by a crashed process, failed as uncertain. */
  stale: number;
  due: number;
  published: number;
  failed: number;
  late: number;
  movedToNextDay: number;
  /** Unipile not connected, or the account disconnected. */
  waiting: number;
  /** Changed by a person, or claimed elsewhere, since the run found it. */
  skipped: number;
  /** Another post of the same account goes first. */
  later: number;
  errors: number;
};

/** Due posts this run looks at, across organizations. */
const MAX_DUE_PER_RUN = 500;

export async function publishScheduledLinkedinPosts({
  organizationId,
  now = new Date(),
}: { organizationId?: string; now?: Date } = {}): Promise<PublishScheduledSummary> {
  const summary: PublishScheduledSummary = { stale: 0, due: 0, published: 0, failed: 0, late: 0, movedToNextDay: 0, waiting: 0, skipped: 0, later: 0, errors: 0 };
  if (isMigrationControlPaused("linkedinPosts")) return { ...summary, paused: true };

  summary.stale = organizationId
    ? await runInOrganization(organizationId, () => failStalePublishingPosts(now))
    : await failStalePublishingPostsEverywhere(now);

  // Across organizations: each post then runs in its own organization's
  // scope. Rows another run (or a person's Publish now) holds are skipped.
  const due: DuePost[] = await db.transaction((tx) =>
    tx
      .select({
        id: linkedinPosts.id,
        organizationId: linkedinPosts.organizationId,
        linkedinAccountId: linkedinPosts.linkedinAccountId,
        scheduledAt: linkedinPosts.scheduledAt,
      })
      .from(linkedinPosts)
      .where(
        and(
          eq(linkedinPosts.status, "scheduled"),
          lte(linkedinPosts.scheduledAt, now),
          organizationId ? eq(linkedinPosts.organizationId, organizationId) : undefined,
        ),
      )
      .orderBy(asc(linkedinPosts.scheduledAt), asc(linkedinPosts.id))
      .limit(MAX_DUE_PER_RUN)
      .for("update", { skipLocked: true })
      .then((rows) => rows.map((row) => ({ ...row, scheduledAt: row.scheduledAt! }))),
  );
  summary.due = due.length;

  const plan = planScheduledRun(due, now);
  summary.later = plan.later.length;

  for (const post of plan.late) {
    try {
      await runInOrganization(post.organizationId, () => failLatePost(post, now));
      summary.late += 1;
    } catch (error) {
      summary.errors += 1;
      console.error("[linkedin/posts] could not fail a late scheduled post", { postId: post.id, error });
    }
  }

  for (const post of plan.publish) {
    try {
      const outcome = await runInOrganization(post.organizationId, () =>
        publishPost(post.id, { publishedBy: SYSTEM_PUBLISHER, now, scheduled: true }),
      );
      if (outcome.status === "published") summary.published += 1;
      else summary.failed += 1;
    } catch (error) {
      if (isPlatformNotConnectedError(error)) {
        summary.waiting += 1;
      } else if (error instanceof PostPublishRefusedError) {
        const reason = error.refusal.reason;
        if (reason === "daily-limit") {
          await runInOrganization(post.organizationId, () => moveToNextDay(post, now));
          summary.movedToNextDay += 1;
        } else if (reason === "account") {
          summary.waiting += 1;
        } else if (reason === "not-due" || error.refusal.status === 404) {
          summary.skipped += 1;
        } else {
          // It can never go out as it is (no text, too long): a person has to fix it.
          await runInOrganization(post.organizationId, () => failScheduled(post, `This scheduled post could not be published: ${error.refusal.message}`));
          summary.failed += 1;
        }
      } else {
        summary.errors += 1;
        console.error("[linkedin/posts] scheduled publish failed", { postId: post.id, error });
      }
    }
  }

  if (summary.due || summary.stale) console.log("[linkedin/posts] scheduled posts run", summary);
  return summary;
}

/** Change a post only if it is still the scheduled post the run found. */
const stillAsFound = (post: DuePost) =>
  and(inOrg(linkedinPosts), eq(linkedinPosts.id, post.id), eq(linkedinPosts.status, "scheduled"), eq(linkedinPosts.scheduledAt, post.scheduledAt));

async function failScheduled(post: DuePost, error: string): Promise<void> {
  await db.update(linkedinPosts).set({ status: "failed", error, updatedAt: new Date() }).where(stillAsFound(post));
}

async function failLatePost(post: DuePost, now: Date): Promise<void> {
  // Say what it was waiting on, if anything was (the list said the same while it waited).
  const [account] = await db
    .select({ status: linkedInAccounts.status, name: linkedInAccounts.name, username: linkedInAccounts.username })
    .from(linkedInAccounts)
    .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, post.linkedinAccountId)));
  const reason = scheduledWaitReason({
    unipileConnected: await isPlatformConnected("unipile"),
    account: account ? { status: account.status, name: account.name || account.username } : null,
    scheduledAt: post.scheduledAt,
    publishedToday: 0,
    postsPerDay: 1,
    nextDayStart: now,
  });
  await failScheduled(post, missedTimeError(reason));
}

async function moveToNextDay(post: DuePost, now: Date): Promise<void> {
  const [general, { postsPerDay }] = await Promise.all([channelRules("general"), channelRules("linkedin")]);
  const [account] = await db
    .select({ name: linkedInAccounts.name, username: linkedInAccounts.username })
    .from(linkedInAccounts)
    .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, post.linkedinAccountId)));
  const nextDayStart = nextOrganizationDayStart(general.timeZone, general.dayStartsAt, now);
  await db
    .update(linkedinPosts)
    .set({
      scheduledAt: nextDayTime(general.timeZone, post.scheduledAt, nextDayStart),
      error: movedToNextDayNote(account?.name || account?.username || "This account", postsPerDay),
      updatedAt: new Date(),
    })
    .where(stillAsFound(post));
}
