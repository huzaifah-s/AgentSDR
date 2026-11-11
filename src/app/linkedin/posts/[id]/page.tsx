import { notFound } from "next/navigation";
import { requirePageOrgContext } from "@/lib/auth/context";
import { getPost, PostApiError } from "@/lib/linkedin/posts/posts.server";
import { isPostId } from "@/lib/linkedin/posts/requests";
import { runInOrganization } from "@/lib/tenancy/scope";
import { PostComposer } from "@/components/linkedin/posts/PostComposer";
import { loadComposerData } from "@/components/linkedin/posts/composerData.server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Post" };

export default async function LinkedinPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isPostId(id)) notFound();
  const ctx = await requirePageOrgContext();
  const loaded = await runInOrganization(ctx.organizationId, async () => {
    try {
      const [post, data] = await Promise.all([getPost(id.toLowerCase()), loadComposerData()]);
      return { post, data };
    } catch (error) {
      if (error instanceof PostApiError && error.status === 404) return null;
      throw error;
    }
  });
  if (!loaded) notFound();
  return <PostComposer key={loaded.post.id} post={loaded.post} {...loaded.data} />;
}
