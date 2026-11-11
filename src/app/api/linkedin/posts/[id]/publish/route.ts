import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { postIdOrThrow, withPostsRoute } from "@/lib/linkedin/posts/http";
import { getPost } from "@/lib/linkedin/posts/posts.server";
import { publishPost } from "@/lib/linkedin/posts/publish";

/**
 * POST: publish now. Answers 200 with the post either way it ended —
 * `published`, or `failed` with the reason on the post (`uncertain` when it
 * may have gone out). A refusal before anything was sent (limit reached,
 * account disconnected, already published) is a 4xx and changes nothing.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withPostsRoute(request, async (ctx) => {
    const id = postIdOrThrow((await params).id);
    const outcome = await publishPost(id, { publishedBy: ctx.userId });
    return NextResponse.json({ outcome, post: await getPost(id) });
  });
}
