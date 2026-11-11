import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { suggestPostIdeas } from "@/lib/linkedin/posts/ai.server";
import { readJson, withPostsRoute } from "@/lib/linkedin/posts/http";
import { PostApiError } from "@/lib/linkedin/posts/posts.server";
import { parsePostIdeas } from "@/lib/linkedin/posts/requests";

/**
 * POST: "Suggest ideas" (Phase 5). Five post ideas from the content brief,
 * the organization's public Knowledge and, unless `includeThemes` is false,
 * prospects' themes. Saves nothing: opening an idea creates a draft with the
 * idea's `source`. 409 when Unipile or OpenRouter is not connected.
 */
export async function POST(request: NextRequest) {
  return withPostsRoute(request, async () => {
    const input = parsePostIdeas(await readJson(request).catch(() => ({})));
    if (!input.ok) throw new PostApiError(400, input.error);
    return NextResponse.json(await suggestPostIdeas(input.value));
  });
}
