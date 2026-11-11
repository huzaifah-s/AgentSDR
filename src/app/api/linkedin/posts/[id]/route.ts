import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { postIdOrThrow, readJson, withPostsRoute } from "@/lib/linkedin/posts/http";
import { deletePost, getPost, PostApiError, updatePost } from "@/lib/linkedin/posts/posts.server";
import { parseUpdatePost } from "@/lib/linkedin/posts/requests";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return withPostsRoute(request, async () => {
    const id = postIdOrThrow((await params).id);
    return NextResponse.json({ post: await getPost(id) });
  });
}

/** PATCH: edit a draft, scheduled or failed post. Published posts are read-only. */
export async function PATCH(request: NextRequest, { params }: Params) {
  return withPostsRoute(request, async () => {
    const id = postIdOrThrow((await params).id);
    const input = parseUpdatePost(await readJson(request));
    if (!input.ok) throw new PostApiError(400, input.error);
    return NextResponse.json({ post: await updatePost(id, input.value) });
  });
}

/** DELETE: a draft, scheduled or failed post, and its images. */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withPostsRoute(request, async () => {
    const id = postIdOrThrow((await params).id);
    await deletePost(id);
    return NextResponse.json({ ok: true });
  });
}
