import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rewritePostDraft } from "@/lib/linkedin/posts/ai.server";
import { readJson, withPostsRoute } from "@/lib/linkedin/posts/http";
import { PostApiError } from "@/lib/linkedin/posts/posts.server";
import { parseRewriteDraft } from "@/lib/linkedin/posts/requests";

/**
 * POST: one rewrite of the composer's current text, as the instruction asks
 * ("shorter", "less salesy"). Saves nothing. 409 when Unipile or OpenRouter
 * is not connected.
 */
export async function POST(request: NextRequest) {
  return withPostsRoute(request, async () => {
    const input = parseRewriteDraft(await readJson(request));
    if (!input.ok) throw new PostApiError(400, input.error);
    return NextResponse.json(await rewritePostDraft(input.value));
  });
}
