import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOpenRouter } from "@/lib/linkedin/posts/ai.server";
import { withPostsRoute } from "@/lib/linkedin/posts/http";
import { PostApiError } from "@/lib/linkedin/posts/posts.server";
import { getAuthorVoice, learnAuthorVoice } from "@/lib/linkedin/posts/voices.server";

type Params = { params: Promise<{ accountId: string }> };

/**
 * POST: "Learn from my posts" (Phase 5). Reads the account's last ~20 posts
 * and describes its voice as blocks, a suggestion for the person to edit:
 * nothing is saved. 409 without OpenRouter or posts to read.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withPostsRoute(request, async () => {
    const id = (await params).accountId;
    if (!id || id.length > 64) throw new PostApiError(404, "LinkedIn account not found");
    // The account first (404 for another organization's), then OpenRouter, then LinkedIn.
    await getAuthorVoice(id);
    await requireOpenRouter();
    try {
      return NextResponse.json(await learnAuthorVoice(id));
    } catch (error) {
      if (error instanceof PostApiError) throw error;
      console.error("[linkedin/posts] learning a voice failed", error);
      throw new PostApiError(502, `The AI could not describe this voice: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    }
  });
}
