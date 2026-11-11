import "server-only";

import { aliasedTable, and, asc, count, desc, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { users } from "@/lib/auth/schema";
import { crmKnowledgeDocuments } from "@/lib/crm/schema";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { isPlatformConnected, isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import {
  attachmentImageId,
  EDITABLE_STATUSES,
  MAX_POST_IMAGES,
  type LinkedinPostAccount,
  type LinkedinPostAttachment,
  type LinkedinPostStatus,
  type LinkedinPostView,
  type PostTime,
  NEARBY_POST_WARNING_MS,
} from "./contract";
import { conversationsLeakMessage } from "./leakCheck.server";
import { failStalePublishingPosts, publishedTodayByAccount } from "./publish";
import { verifyTheme } from "./themes.server";
import type { CreatePostInput, ImageUpload, ListQuery, PostOrigin, SchedulePostInput, UpdatePostInput } from "./requests";
import { nextOrganizationDayStart, scheduledWaitReason, scheduleInstant, scheduleRefusal } from "./scheduleRules";
import { linkedinPosts, type LinkedinPostRow } from "./schema";
import { deletePostImages, postImageFile, postImageKey, putPostImage } from "./storage";

/**
 * Reading and changing posts in the organization in scope. Every query
 * filters by organization, so another organization's post is "not found".
 */

export class PostApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PostApiError";
  }
}

const notFound = () => new PostApiError(404, "Post not found");

const creator = aliasedTable(users, "creator");
const publisher = aliasedTable(users, "publisher");

const ACCOUNT_COLUMNS = {
  id: linkedInAccounts.id,
  name: linkedInAccounts.name,
  username: linkedInAccounts.username,
  profilePictureUrl: linkedInAccounts.profilePictureUrl,
  status: linkedInAccounts.status,
};

/** Newest first, or for scheduled posts, soonest first. */
type ViewOrder = "recent" | "soonest";

async function selectViews(where: SQL | undefined, limit?: { limit: number; offset: number }, order: ViewOrder = "recent"): Promise<LinkedinPostView[]> {
  const query = db
    .select({
      post: linkedinPosts,
      account: ACCOUNT_COLUMNS,
      creatorName: creator.name,
      publisherName: publisher.name,
    })
    .from(linkedinPosts)
    // The account join is org-filtered too: a post can only show its own organization's account.
    .leftJoin(linkedInAccounts, and(eq(linkedInAccounts.id, linkedinPosts.linkedinAccountId), inOrg(linkedInAccounts)))
    .leftJoin(creator, sql`${creator.id}::text = ${linkedinPosts.createdBy}`)
    .leftJoin(publisher, sql`${publisher.id}::text = ${linkedinPosts.publishedBy}`)
    .where(and(inOrg(linkedinPosts), where))
    .orderBy(
      ...(order === "soonest"
        ? [asc(linkedinPosts.scheduledAt), asc(linkedinPosts.id)]
        : [desc(sql`coalesce(${linkedinPosts.publishedAt}, ${linkedinPosts.updatedAt})`), desc(linkedinPosts.id)]),
    );
  const rows = limit ? await query.limit(limit.limit).offset(limit.offset) : await query;
  return withWaiting(
    rows.map(({ post, account, creatorName, publisherName }) => toView(post, account?.id ? (account as LinkedinPostAccount) : null, creatorName, publisherName)),
  );
}

/**
 * Fill in why each scheduled post is waiting (scheduleRules.scheduledWaitReason).
 * Reads the rules and today's counts only when there is a scheduled post.
 */
async function withWaiting(views: LinkedinPostView[]): Promise<LinkedinPostView[]> {
  if (!views.some((view) => view.status === "scheduled")) return views;
  const now = new Date();
  const [unipileConnected, { postsPerDay }, general, publishedToday] = await Promise.all([
    isPlatformConnected("unipile"),
    channelRules("linkedin"),
    channelRules("general"),
    publishedTodayByAccount(now),
  ]);
  const nextDayStart = nextOrganizationDayStart(general.timeZone, general.dayStartsAt, now);
  return views.map((view) =>
    view.status !== "scheduled" || !view.scheduledAt
      ? view
      : {
          ...view,
          waiting: scheduledWaitReason({
            unipileConnected,
            account: view.account ? { status: view.account.status, name: view.account.name || view.account.username } : null,
            scheduledAt: new Date(view.scheduledAt),
            publishedToday: view.account ? publishedToday[view.account.id] ?? 0 : 0,
            postsPerDay,
            nextDayStart,
          }),
        },
  );
}

function toView(post: LinkedinPostRow, account: LinkedinPostAccount | null, creatorName: string | null, publisherName: string | null): LinkedinPostView {
  return {
    id: post.id,
    status: post.status,
    body: post.body,
    attachments: post.attachments.map((attachment) => ({ ...attachment, imageId: attachmentImageId(attachment.key) })),
    account,
    source: post.source ?? null,
    generation: post.generation ?? null,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    waiting: null,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    postUrl: post.postUrl,
    error: post.error,
    createdBy: post.createdBy ? { id: post.createdBy, name: creatorName } : null,
    publishedBy: post.publishedBy ? { id: post.publishedBy, name: post.publishedBy === "system" ? "Scheduled" : publisherName } : null,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

export async function listPosts(
  query: ListQuery,
): Promise<{ posts: LinkedinPostView[]; total: number; counts: Record<LinkedinPostStatus, number>; upcoming: LinkedinPostView[] }> {
  // The scheduled-posts job also retires a post a crashed process left in
  // `publishing`; reading the list does it too, so it never waits on the job.
  await failStalePublishingPosts();
  const filters = and(
    query.statuses ? inArray(linkedinPosts.status, query.statuses) : undefined,
    query.linkedinAccountId ? eq(linkedinPosts.linkedinAccountId, query.linkedinAccountId) : undefined,
  );
  const onlyScheduled = query.statuses?.length === 1 && query.statuses[0] === "scheduled";
  const [posts, totals, upcoming] = await Promise.all([
    selectViews(filters, { limit: query.pageSize, offset: (query.page - 1) * query.pageSize }, onlyScheduled ? "soonest" : "recent"),
    db
      .select({ status: linkedinPosts.status, n: count() })
      .from(linkedinPosts)
      .where(and(inOrg(linkedinPosts), query.linkedinAccountId ? eq(linkedinPosts.linkedinAccountId, query.linkedinAccountId) : undefined))
      .groupBy(linkedinPosts.status),
    nextScheduledPerAccount(),
  ]);
  const counts: Record<LinkedinPostStatus, number> = { draft: 0, scheduled: 0, publishing: 0, published: 0, failed: 0 };
  for (const row of totals) counts[row.status] = row.n;
  const total = query.statuses ? query.statuses.reduce((sum, status) => sum + counts[status], 0) : Object.values(counts).reduce((a, b) => a + b, 0);
  return { posts, total, counts, upcoming };
}

/** Each account's next scheduled post, soonest first: the list's "Coming up". */
export async function nextScheduledPerAccount(): Promise<LinkedinPostView[]> {
  const next = await db
    .selectDistinctOn([linkedinPosts.linkedinAccountId], { id: linkedinPosts.id })
    .from(linkedinPosts)
    .where(and(inOrg(linkedinPosts), eq(linkedinPosts.status, "scheduled")))
    .orderBy(linkedinPosts.linkedinAccountId, asc(linkedinPosts.scheduledAt), asc(linkedinPosts.id));
  if (!next.length) return [];
  return selectViews(inArray(linkedinPosts.id, next.map((row) => row.id)), undefined, "soonest");
}

/**
 * Each account's scheduled posts and the ones published in the last 4
 * hours, for the composer's "another post within 4 hours" warning.
 */
export async function postTimesByAccount(now: Date = new Date()): Promise<Record<string, PostTime[]>> {
  const since = new Date(now.getTime() - NEARBY_POST_WARNING_MS);
  const rows = await db
    .select({
      id: linkedinPosts.id,
      accountId: linkedinPosts.linkedinAccountId,
      status: linkedinPosts.status,
      at: sql<Date>`coalesce(${linkedinPosts.publishedAt}, ${linkedinPosts.scheduledAt}, ${linkedinPosts.updatedAt})`.mapWith((value) => new Date(value)),
    })
    .from(linkedinPosts)
    .where(
      and(
        inOrg(linkedinPosts),
        or(
          eq(linkedinPosts.status, "scheduled"),
          eq(linkedinPosts.status, "publishing"),
          and(eq(linkedinPosts.status, "published"), gte(linkedinPosts.publishedAt, since)),
        ),
      ),
    )
    .orderBy(asc(linkedinPosts.scheduledAt))
    .limit(2000);
  const byAccount: Record<string, PostTime[]> = {};
  for (const row of rows) {
    (byAccount[row.accountId] ??= []).push({ id: row.id, at: row.at.toISOString(), status: row.status as PostTime["status"] });
  }
  return byAccount;
}

export async function getPost(postId: string): Promise<LinkedinPostView> {
  await failStalePublishingPosts();
  const [view] = await selectViews(eq(linkedinPosts.id, postId));
  if (!view) throw notFound();
  return view;
}

/** The organization's LinkedIn accounts, for the account picker. */
export async function listPostAccounts(): Promise<LinkedinPostAccount[]> {
  return db
    .select(ACCOUNT_COLUMNS)
    .from(linkedInAccounts)
    .where(inOrg(linkedInAccounts))
    .orderBy(asc(linkedInAccounts.name), asc(linkedInAccounts.username));
}

async function assertAccountInOrg(linkedinAccountId: string): Promise<void> {
  const [account] = await db
    .select({ id: linkedInAccounts.id })
    .from(linkedInAccounts)
    .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, linkedinAccountId)));
  // Same answer as an unknown id: another organization's account is not confirmed to exist.
  if (!account) throw new PostApiError(400, "Choose one of your organization's LinkedIn accounts");
}

/**
 * An AI draft's source may only name the organization's own Knowledge, and a
 * `conversations` source must carry this organization's seal over its theme:
 * the server wrote it (/generate or /rewrite), the browser only hands it back.
 */
async function assertOriginInOrg(origin: PostOrigin | undefined): Promise<void> {
  const source = origin?.source;
  if (source?.kind === "conversations") {
    const sealed =
      source.themeTitle && source.themeSummary && source.themesReadAt && source.seal &&
      verifyTheme({ title: source.themeTitle, summary: source.themeSummary, readAt: source.themesReadAt, seal: source.seal });
    if (!sealed) throw new PostApiError(400, "The post's theme is not one AgentSDR found for your organization. Find themes again.");
  }
  const ids = origin?.source.knowledgeDocumentIds ?? [];
  if (!ids.length) return;
  const found = await db
    .select({ id: crmKnowledgeDocuments.id })
    .from(crmKnowledgeDocuments)
    .where(and(inOrg(crmKnowledgeDocuments), inArray(crmKnowledgeDocuments.id, ids)));
  if (found.length !== ids.length) throw new PostApiError(400, "The post's source names a Knowledge document that was not found");
}

export async function createPost(input: CreatePostInput, userId: string): Promise<LinkedinPostView> {
  await assertAccountInOrg(input.linkedinAccountId);
  await assertOriginInOrg(input.origin);
  const [row] = await db
    .insert(linkedinPosts)
    .values({
      organizationId: currentOrganizationId(),
      linkedinAccountId: input.linkedinAccountId,
      body: input.body,
      source: input.origin?.source ?? { kind: "blank" },
      generation: input.origin?.generation ?? null,
      createdBy: userId,
    })
    .returning({ id: linkedinPosts.id });
  return getPost(row.id);
}

function editableError(status: LinkedinPostStatus): PostApiError {
  if (status === "published") return new PostApiError(409, "Published posts cannot be changed.");
  if (status === "publishing") return new PostApiError(409, "This post is being published.");
  return new PostApiError(409, "This post cannot be changed.");
}

/**
 * Edit a draft, scheduled or failed post. A failed post becomes a draft
 * again (its error cleared), which is how a person tries again after
 * checking LinkedIn.
 */
export async function updatePost(postId: string, input: UpdatePostInput): Promise<LinkedinPostView> {
  if (input.linkedinAccountId) await assertAccountInOrg(input.linkedinAccountId);
  await assertOriginInOrg(input.origin);
  const updated = await db.transaction(async (tx) => {
    const [post] = await tx
      .select({ status: linkedinPosts.status, source: linkedinPosts.source })
      .from(linkedinPosts)
      .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)))
      .for("update");
    if (!post) throw notFound();
    if (!EDITABLE_STATUSES.includes(post.status)) throw editableError(post.status);
    // Written from prospects' themes stays so: the text may still carry what
    // the theme drafts said, so the leak guard keeps running at publish even
    // after a later draft from a topic or Knowledge.
    const source =
      input.origin && post.source?.kind === "conversations" && input.origin.source.kind !== "conversations" ? post.source : input.origin?.source;
    // Editing keeps a scheduled post scheduled, so it must stay publishable.
    if (post.status === "scheduled" && input.body !== undefined && !input.body.trim()) {
      throw new PostApiError(400, "A scheduled post needs text. Unschedule it to keep it as an empty draft.");
    }
    const nextStatus: LinkedinPostStatus = post.status === "failed" ? "draft" : post.status;
    return tx
      .update(linkedinPosts)
      .set({
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.linkedinAccountId ? { linkedinAccountId: input.linkedinAccountId } : {}),
        ...(input.origin ? { source, generation: input.origin.generation } : {}),
        status: nextStatus,
        ...(post.status === "failed" ? { error: null, publishedBy: null } : {}),
        updatedAt: new Date(),
      })
      .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)))
      .returning({ id: linkedinPosts.id });
  });
  if (!updated.length) throw notFound();
  return getPost(postId);
}

/**
 * Schedule a draft, or move a scheduled post, to a date and time read in the
 * organization's time zone. Clears a note the scheduler left (moved to the
 * next day), since the person chose a new time.
 */
export async function schedulePost(postId: string, input: SchedulePostInput, now: Date = new Date()): Promise<LinkedinPostView> {
  const { timeZone } = await channelRules("general");
  const scheduledAt = scheduleInstant(timeZone, input.date, input.time);
  if (!scheduledAt) throw new PostApiError(400, "That date does not exist.");
  await db.transaction(async (tx) => {
    const [post] = await tx
      .select({ status: linkedinPosts.status, body: linkedinPosts.body, source: linkedinPosts.source, createdAt: linkedinPosts.createdAt })
      .from(linkedinPosts)
      .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)))
      .for("update");
    if (!post) throw notFound();
    const refusal = scheduleRefusal({ status: post.status, body: post.body, scheduledAt, now });
    if (refusal) throw new PostApiError(refusal.status, refusal.message);
    // Checked now so the rep hears of it while they are here; the job checks again at publish.
    const leak = await conversationsLeakMessage(post, tx);
    if (leak) throw new PostApiError(409, leak);
    await tx
      .update(linkedinPosts)
      .set({ status: "scheduled", scheduledAt, error: null, updatedAt: now })
      .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)));
  });
  return getPost(postId);
}

/** Put a scheduled post back to a draft. */
export async function unschedulePost(postId: string): Promise<LinkedinPostView> {
  await db.transaction(async (tx) => {
    const [post] = await tx
      .select({ status: linkedinPosts.status })
      .from(linkedinPosts)
      .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)))
      .for("update");
    if (!post) throw notFound();
    if (post.status !== "scheduled") {
      throw post.status === "publishing" || post.status === "published" ? editableError(post.status) : new PostApiError(409, "This post is not scheduled.");
    }
    await tx
      .update(linkedinPosts)
      .set({ status: "draft", scheduledAt: null, error: null, updatedAt: new Date() })
      .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)));
  });
  return getPost(postId);
}

/** Delete a draft, scheduled or failed post and its images. */
export async function deletePost(postId: string): Promise<void> {
  const [post] = await db
    .select({ status: linkedinPosts.status, attachments: linkedinPosts.attachments })
    .from(linkedinPosts)
    .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)));
  if (!post) throw notFound();
  if (!EDITABLE_STATUSES.includes(post.status)) throw editableError(post.status);

  try {
    await deletePostImages(post.attachments.map((attachment) => attachment.key));
  } catch (error) {
    // R2 disconnected since the upload: the objects cannot be reached by us
    // any more, so they must not keep the draft alive.
    if (!isPlatformNotConnectedError(error)) throw new PostApiError(502, "Could not delete this post's images. Try again.");
    console.warn("[linkedin/posts] R2 not connected; deleting a post without its images", { postId });
  }

  const deleted = await db
    .delete(linkedinPosts)
    .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId), inArray(linkedinPosts.status, [...EDITABLE_STATUSES])))
    .returning({ id: linkedinPosts.id });
  if (!deleted.length) throw new PostApiError(409, "This post changed while it was being deleted. Reload and try again.");
}

/** The post's attachments, checked editable and with room, before an upload. */
export async function assertCanAddImage(postId: string): Promise<{ existingCount: number }> {
  const [post] = await db
    .select({ status: linkedinPosts.status, attachments: linkedinPosts.attachments })
    .from(linkedinPosts)
    .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)));
  if (!post) throw notFound();
  if (!EDITABLE_STATUSES.includes(post.status)) throw editableError(post.status);
  return { existingCount: post.attachments.length };
}

/**
 * Store an image in R2, then add it to the post. If the post changed
 * meanwhile (published, or already full), the object is removed again.
 */
export async function addPostImage(postId: string, upload: ImageUpload, bytes: Uint8Array): Promise<LinkedinPostView> {
  const key = postImageKey(postId, postImageFile(upload.contentType));
  await putPostImage(key, bytes, upload.contentType);
  const attachment: LinkedinPostAttachment = { key, fileName: upload.fileName, contentType: upload.contentType, bytes: upload.bytes };
  try {
    await db.transaction(async (tx) => {
      const [post] = await tx
        .select({ status: linkedinPosts.status, attachments: linkedinPosts.attachments })
        .from(linkedinPosts)
        .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)))
        .for("update");
      if (!post) throw notFound();
      if (!EDITABLE_STATUSES.includes(post.status)) throw editableError(post.status);
      if (post.attachments.length >= MAX_POST_IMAGES) throw new PostApiError(400, `A post can have at most ${MAX_POST_IMAGES} images.`);
      await tx
        .update(linkedinPosts)
        .set({ attachments: [...post.attachments, attachment], updatedAt: new Date() })
        .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)));
    });
  } catch (error) {
    await deletePostImages([key]).catch((cleanup) => console.warn("[linkedin/posts] could not remove an unused image", { key, cleanup }));
    throw error;
  }
  return getPost(postId);
}

/** The attachment of this post whose key carries `imageId`. */
function findImage(attachments: LinkedinPostAttachment[], imageId: string): LinkedinPostAttachment | undefined {
  return attachments.find((attachment) => attachmentImageId(attachment.key) === imageId.toLowerCase());
}

export async function removePostImage(postId: string, imageId: string): Promise<LinkedinPostView> {
  let key = "";
  await db.transaction(async (tx) => {
    const [post] = await tx
      .select({ status: linkedinPosts.status, attachments: linkedinPosts.attachments })
      .from(linkedinPosts)
      .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)))
      .for("update");
    if (!post) throw notFound();
    if (!EDITABLE_STATUSES.includes(post.status)) throw editableError(post.status);
    const image = findImage(post.attachments, imageId);
    if (!image) throw new PostApiError(404, "Image not found");
    key = image.key;
    await tx
      .update(linkedinPosts)
      .set({ attachments: post.attachments.filter((attachment) => attachment.key !== key), updatedAt: new Date() })
      .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)));
  });
  await deletePostImages([key]).catch((error) => console.warn("[linkedin/posts] could not delete a removed image", { key, error }));
  return getPost(postId);
}

/** An image of a post in this organization (any status), for display. */
export async function postImageKeyFor(postId: string, imageId: string): Promise<string> {
  const [post] = await db
    .select({ attachments: linkedinPosts.attachments })
    .from(linkedinPosts)
    .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)));
  const image = post ? findImage(post.attachments, imageId) : undefined;
  if (!image) throw new PostApiError(404, "Image not found");
  return image.key;
}
