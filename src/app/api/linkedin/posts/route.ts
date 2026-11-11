import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readJson, withPostsRoute } from "@/lib/linkedin/posts/http";
import { createPost, listPosts, PostApiError } from "@/lib/linkedin/posts/posts.server";
import { parseCreatePost, parseListQuery } from "@/lib/linkedin/posts/requests";

/** GET: the organization's posts (status, account, paged). */
export async function GET(request: NextRequest) {
  return withPostsRoute(request, async () => {
    const query = parseListQuery(request.nextUrl.searchParams);
    if (!query.ok) throw new PostApiError(400, query.error);
    return NextResponse.json(await listPosts(query.value));
  });
}

/** POST: a new draft. */
export async function POST(request: NextRequest) {
  return withPostsRoute(request, async (ctx) => {
    const input = parseCreatePost(await readJson(request));
    if (!input.ok) throw new PostApiError(400, input.error);
    return NextResponse.json({ post: await createPost(input.value, ctx.userId) }, { status: 201 });
  });
}
