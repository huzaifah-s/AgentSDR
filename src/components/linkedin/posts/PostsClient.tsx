"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { RiAddLine, RiArrowLeftSLine, RiArrowRightSLine, RiExternalLinkLine, RiFileTextLine, RiImageLine } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Table from "@/components/alignui/table";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { LinkedInAccountTag } from "@/components/linkedin/LinkedInAccountTag";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { PageTabs } from "@/components/page/PageTabs";
import { firstLine, POST_TABS, type LinkedinPostStatus, type LinkedinPostView, type PostTab } from "@/lib/linkedin/posts/contract";
import { cn } from "@/utils/cn";

const EMPTY: Record<PostTab, { title: string; description: string }> = {
  drafts: { title: "No drafts", description: "Write a post and save it as a draft to come back to it." },
  scheduled: { title: "Nothing scheduled", description: "Scheduling posts for later is coming soon. For now, publish a post when it is ready." },
  published: { title: "Nothing published yet", description: "Posts you publish from AgentSDR show here, with a link to each on LinkedIn." },
  failed: { title: "No failed posts", description: "A post LinkedIn refused, or one whose publish could not be confirmed, shows here." },
};

function when(post: LinkedinPostView): { label: string; iso: string } {
  if (post.publishedAt) return { label: "Published", iso: post.publishedAt };
  if (post.scheduledAt && post.status === "scheduled") return { label: "Scheduled for", iso: post.scheduledAt };
  return { label: "Edited", iso: post.updatedAt };
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function StatusBadge({ status }: { status: LinkedinPostStatus }) {
  if (status === "publishing") return <Badge.Root variant="lighter" color="blue" size="small">Publishing…</Badge.Root>;
  if (status === "failed") return <Badge.Root variant="lighter" color="red" size="small">Failed</Badge.Root>;
  return null;
}

export function PostsClient({
  tab,
  posts,
  total,
  counts,
  page,
  pageSize,
}: {
  tab: PostTab;
  posts: LinkedinPostView[];
  total: number;
  counts: Record<LinkedinPostStatus, number>;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const tabs = POST_TABS.map((t) => ({ value: t.value, label: t.label, count: t.statuses.reduce((sum, s) => sum + counts[s], 0) }));
  const href = (nextTab: PostTab, nextPage = 1) => `/linkedin/posts?tab=${nextTab}${nextPage > 1 ? `&page=${nextPage}` : ""}`;

  const newPost = (
    <Button.Root variant="primary" mode="filled" size="small" asChild>
      <Link href="/linkedin/posts/new">
        <Button.Icon as={RiAddLine} />
        New post
      </Link>
    </Button.Root>
  );

  return (
    <div className="mx-auto w-full max-w-[1440px]">
      <PageHeader
        title="LinkedIn posts"
        description="Write posts and publish them from your organization's LinkedIn accounts, on each person's own profile."
        actions={newPost}
      />

      <PageTabs className="mt-6" label="Posts" tabs={tabs} value={tab} onChange={(next) => router.push(href(next))} />

      <Frame className="mt-5">
        <FrameHeader
          title={POST_TABS.find((t) => t.value === tab)?.label ?? "Posts"}
          description={tab === "published" ? "Newest first. Open one on LinkedIn from its link." : "Newest first. Select a post to edit or publish it."}
        />
        <FramePanel className="overflow-x-auto p-2 sm:p-2">
          {posts.length === 0 ? (
            <EmptyState icon={RiFileTextLine} title={EMPTY[tab].title} description={EMPTY[tab].description} action={tab === "drafts" ? newPost : undefined} />
          ) : (
            <Table.Root className="min-w-[860px] [&>table]:table-fixed">
              <Table.Header>
                <Table.Row>
                  <Table.Head scope="col" className="w-48 px-4">Account</Table.Head>
                  <Table.Head scope="col" className="px-4">Post</Table.Head>
                  <Table.Head scope="col" className="w-44 px-4">When</Table.Head>
                  <Table.Head scope="col" className="w-44 px-4">By</Table.Head>
                  <Table.Head scope="col" className="w-28 px-4"><span className="sr-only">Link</span></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {posts.map((post) => {
                  const time = when(post);
                  const by = post.publishedBy ?? post.createdBy;
                  return (
                    <Table.Row key={post.id} className="cursor-pointer" onClick={() => router.push(`/linkedin/posts/${post.id}`)}>
                      <Table.Cell className="px-4">
                        {post.account ? <LinkedInAccountTag account={post.account} /> : <span className="text-paragraph-xs text-text-soft-400">Account removed</span>}
                      </Table.Cell>
                      <Table.Cell className="px-4">
                        <div className="flex min-w-0 items-center gap-2">
                          <StatusBadge status={post.status} />
                          <Link
                            href={`/linkedin/posts/${post.id}`}
                            onClick={(event) => event.stopPropagation()}
                            className={cn("truncate text-label-sm outline-none hover:underline focus-visible:underline", firstLine(post.body) ? "text-text-strong-950" : "text-text-soft-400")}
                          >
                            {firstLine(post.body) || "Empty draft"}
                          </Link>
                          {post.attachments.length > 0 && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 text-paragraph-xs text-text-sub-600" title={`${post.attachments.length} image(s)`}>
                              <RiImageLine className="size-3.5" />
                              {post.attachments.length}
                            </span>
                          )}
                        </div>
                        {post.status === "failed" && post.error && <p className="mt-0.5 truncate text-paragraph-xs text-error-base">{post.error}</p>}
                      </Table.Cell>
                      <Table.Cell className="px-4 text-paragraph-xs text-text-sub-600">
                        <span className="text-text-soft-400">{time.label}</span> <time dateTime={time.iso}>{formatWhen(time.iso)}</time>
                      </Table.Cell>
                      <Table.Cell className="truncate px-4 text-paragraph-xs text-text-sub-600">
                        {by ? (
                          <>
                            <span className="text-text-soft-400">{post.publishedBy ? "Published by" : "Written by"}</span> {by.name ?? "a former member"}
                          </>
                        ) : (
                          "—"
                        )}
                      </Table.Cell>
                      <Table.Cell className="px-4">
                        {post.postUrl ? (
                          <a
                            href={post.postUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            className="inline-flex items-center gap-1 text-label-xs text-primary-base hover:underline"
                          >
                            On LinkedIn
                            <RiExternalLinkLine className="size-3.5" />
                          </a>
                        ) : post.status === "published" ? (
                          <span className="text-paragraph-xs text-text-soft-400" title="LinkedIn did not return a link for this post">No link</span>
                        ) : null}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          )}
        </FramePanel>
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 px-4 py-3 text-paragraph-xs text-text-sub-600">
            <span className="tabular-nums">
              Page {page} of {pages}
            </span>
            <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={page <= 1} asChild={page > 1}>
              {page > 1 ? (
                <Link href={href(tab, page - 1)} aria-label="Previous page">
                  <Button.Icon as={RiArrowLeftSLine} />
                </Link>
              ) : (
                <span aria-label="Previous page"><Button.Icon as={RiArrowLeftSLine} /></span>
              )}
            </Button.Root>
            <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={page >= pages} asChild={page < pages}>
              {page < pages ? (
                <Link href={href(tab, page + 1)} aria-label="Next page">
                  <Button.Icon as={RiArrowRightSLine} />
                </Link>
              ) : (
                <span aria-label="Next page"><Button.Icon as={RiArrowRightSLine} /></span>
              )}
            </Button.Root>
          </div>
        )}
      </Frame>
    </div>
  );
}
