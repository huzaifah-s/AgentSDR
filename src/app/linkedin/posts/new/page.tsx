import { requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";
import { PostComposer } from "@/components/linkedin/posts/PostComposer";
import { loadComposerData } from "@/components/linkedin/posts/composerData.server";

export const dynamic = "force-dynamic";
export const metadata = { title: "New post" };

export default async function NewLinkedinPostPage() {
  const ctx = await requirePageOrgContext();
  const data = await runInOrganization(ctx.organizationId, loadComposerData);
  return <PostComposer post={null} {...data} />;
}
