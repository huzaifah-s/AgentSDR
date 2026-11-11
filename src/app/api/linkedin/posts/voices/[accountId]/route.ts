import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readJson, withPostsRoute } from "@/lib/linkedin/posts/http";
import { MAX_VOICE_EXAMPLES } from "@/lib/linkedin/posts/postInstructions";
import { PostApiError } from "@/lib/linkedin/posts/posts.server";
import { parseAuthorVoice } from "@/lib/linkedin/posts/requests";
import { getAuthorVoice, saveAuthorVoice } from "@/lib/linkedin/posts/voices.server";

type Params = { params: Promise<{ accountId: string }> };

function accountIdOrThrow(value: string): string {
  if (!value || value.length > 64) throw new PostApiError(404, "LinkedIn account not found");
  return value;
}

/** GET: the account's writing voice (Phase 5); empty when none is written. Another organization's account is 404. */
export async function GET(request: NextRequest, { params }: Params) {
  return withPostsRoute(request, async () => {
    const id = accountIdOrThrow((await params).accountId);
    return NextResponse.json({ voice: await getAuthorVoice(id) });
  });
}

/** PUT: save it. Any member may (decision 2); who did is kept. */
export async function PUT(request: NextRequest, { params }: Params) {
  return withPostsRoute(request, async (ctx) => {
    const id = accountIdOrThrow((await params).accountId);
    const input = parseAuthorVoice(await readJson(request), MAX_VOICE_EXAMPLES);
    if (!input.ok) throw new PostApiError(400, input.error);
    return NextResponse.json({ voice: await saveAuthorVoice(id, input.value, ctx.userId) });
  });
}
