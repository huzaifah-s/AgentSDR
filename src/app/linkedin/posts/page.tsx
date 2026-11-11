import { requirePageOrgContext } from "@/lib/auth/context";
import { channelRules } from "@/lib/channels/rules.server";
import { postTab } from "@/lib/linkedin/posts/contract";
import { openRouterProblem } from "@/lib/linkedin/posts/ai.server";
import { listPostAccounts, listPosts } from "@/lib/linkedin/posts/posts.server";
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
  const [{ posts, total, counts, upcoming }, { timeZone }, aiProblem, accounts] = await runInOrganization(ctx.organizationId, () =>
    Promise.all([
      listPosts({ statuses: [...tab.statuses], linkedinAccountId: null, page, pageSize: PAGE_SIZE }),
      channelRules("general"),
      openRouterProblem(),
      listPostAccounts(),
    ]),
  );
  return (
    <PostsClient
      tab={tab.value}
      posts={posts}
      total={total}
      counts={counts}
      upcoming={upcoming}
      timeZone={timeZone}
      page={page}
      pageSize={PAGE_SIZE}
      aiReady={!aiProblem}
      accounts={accounts}
    />
  );
}
