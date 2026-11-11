import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { draftPosts } from "@/lib/linkedin/posts/ai.server";
import { readJson, withPostsRoute } from "@/lib/linkedin/posts/http";
import { PostApiError } from "@/lib/linkedin/posts/posts.server";
import { parseGenerateDrafts } from "@/lib/linkedin/posts/requests";

/**
 * POST: three AI drafts from a topic and Knowledge, in the chosen account's
 * voice. Saves nothing: the rep picks one, and saving the post records its
 * `source` and `generation`. 409 when Unipile or OpenRouter is not connected.
 */
export async function POST(request: NextRequest) {
  return withPostsRoute(request, async () => {
    const input = parseGenerateDrafts(await readJson(request));
    if (!input.ok) throw new PostApiError(400, input.error);
    return NextResponse.json(await draftPosts(input.value));
  });
}
