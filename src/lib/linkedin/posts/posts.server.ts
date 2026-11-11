import "server-only";

import { aliasedTable, and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/auth/schema";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import {
  attachmentImageId,
  EDITABLE_STATUSES,
  MAX_POST_IMAGES,
  type LinkedinPostAccount,
  type LinkedinPostAttachment,
  type LinkedinPostStatus,
  type LinkedinPostView,
} from "./contract";
import { failStalePublishingPosts } from "./publish";
import type { CreatePostInput, ImageUpload, ListQuery, UpdatePostInput } from "./requests";
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

async function selectViews(where: SQL | undefined, limit?: { limit: number; offset: number }): Promise<LinkedinPostView[]> {
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
    .orderBy(desc(sql`coalesce(${linkedinPosts.publishedAt}, ${linkedinPosts.updatedAt})`), desc(linkedinPosts.id));
  const rows = limit ? await query.limit(limit.limit).offset(limit.offset) : await query;
  return rows.map(({ post, account, creatorName, publisherName }) =>
    toView(post, account?.id ? (account as LinkedinPostAccount) : null, creatorName, publisherName),
  );
}

function toView(post: LinkedinPostRow, account: LinkedinPostAccount | null, creatorName: string | null, publisherName: string | null): LinkedinPostView {
  return {
    id: post.id,
    status: post.status,
    body: post.body,
    attachments: post.attachments.map((attachment) => ({ ...attachment, imageId: attachmentImageId(attachment.key) })),
    account,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    postUrl: post.postUrl,
    error: post.error,
    createdBy: post.createdBy ? { id: post.createdBy, name: creatorName } : null,
    publishedBy: post.publishedBy ? { id: post.publishedBy, name: post.publishedBy === "system" ? "Scheduled" : publisherName } : null,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

export async function listPosts(query: ListQuery): Promise<{ posts: LinkedinPostView[]; total: number; counts: Record<LinkedinPostStatus, number> }> {
  // Until the Phase 3 job exists, reading the list is what retires a post a
  // crashed process left in `publishing`.
  await failStalePublishingPosts();
  const filters = and(
    query.statuses ? inArray(linkedinPosts.status, query.statuses) : undefined,
    query.linkedinAccountId ? eq(linkedinPosts.linkedinAccountId, query.linkedinAccountId) : undefined,
  );
  const [posts, totals] = await Promise.all([
    selectViews(filters, { limit: query.pageSize, offset: (query.page - 1) * query.pageSize }),
    db
      .select({ status: linkedinPosts.status, n: count() })
      .from(linkedinPosts)
      .where(and(inOrg(linkedinPosts), query.linkedinAccountId ? eq(linkedinPosts.linkedinAccountId, query.linkedinAccountId) : undefined))
      .groupBy(linkedinPosts.status),
  ]);
  const counts: Record<LinkedinPostStatus, number> = { draft: 0, scheduled: 0, publishing: 0, published: 0, failed: 0 };
  for (const row of totals) counts[row.status] = row.n;
  const total = query.statuses ? query.statuses.reduce((sum, status) => sum + counts[status], 0) : Object.values(counts).reduce((a, b) => a + b, 0);
  return { posts, total, counts };
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

export async function createPost(input: CreatePostInput, userId: string): Promise<LinkedinPostView> {
  await assertAccountInOrg(input.linkedinAccountId);
  const [row] = await db
    .insert(linkedinPosts)
    .values({
      organizationId: currentOrganizationId(),
      linkedinAccountId: input.linkedinAccountId,
      body: input.body,
      source: { kind: "blank" },
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
  const updated = await db.transaction(async (tx) => {
    const [post] = await tx
      .select({ status: linkedinPosts.status })
      .from(linkedinPosts)
      .where(and(inOrg(linkedinPosts), eq(linkedinPosts.id, postId)))
      .for("update");
    if (!post) throw notFound();
    if (!EDITABLE_STATUSES.includes(post.status)) throw editableError(post.status);
    const nextStatus: LinkedinPostStatus = post.status === "failed" ? "draft" : post.status;
    return tx
      .update(linkedinPosts)
      .set({
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.linkedinAccountId ? { linkedinAccountId: input.linkedinAccountId } : {}),
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
