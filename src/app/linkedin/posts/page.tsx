import { requirePageOrgContext } from "@/lib/auth/context";
import { postTab } from "@/lib/linkedin/posts/contract";
import { listPosts } from "@/lib/linkedin/posts/posts.server";
import { runInOrganization } from "@/lib/tenancy/scope";
import { PostsClient } from "@/components/linkedin/posts/PostsClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Posts" };

const PAGE_SIZE = 25;

export default async function LinkedinPostsPage({ searchParams }: { searchParams: Promise<{ tab?: string; page?: string }> }) {
  const ctx = await requirePageOrgContext();
  const params = await searchParams;
  const tab = postTab(params.tab);
  const page = Math.max(1, Math.floor(Number(params.page) || 1));
  const { posts, total, counts } = await runInOrganization(ctx.organizationId, () =>
    listPosts({ statuses: [...tab.statuses], linkedinAccountId: null, page, pageSize: PAGE_SIZE }),
  );
  return <PostsClient tab={tab.value} posts={posts} total={total} counts={counts} page={page} pageSize={PAGE_SIZE} />;
}
