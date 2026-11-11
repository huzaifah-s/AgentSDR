import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { postIdOrThrow, readJson, withPostsRoute } from "@/lib/linkedin/posts/http";
import { PostApiError, schedulePost, unschedulePost } from "@/lib/linkedin/posts/posts.server";
import { parseSchedulePost } from "@/lib/linkedin/posts/requests";

type Params = { params: Promise<{ id: string }> };

/** POST `{ date, time }`: schedule a draft, or move a scheduled post (the organization's time zone, at least 5 minutes ahead). */
export async function POST(request: NextRequest, { params }: Params) {
  return withPostsRoute(request, async () => {
    const id = postIdOrThrow((await params).id);
    const input = parseSchedulePost(await readJson(request));
    if (!input.ok) throw new PostApiError(400, input.error);
    return NextResponse.json({ post: await schedulePost(id, input.value) });
  });
}

/** DELETE: unschedule, back to a draft. */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withPostsRoute(request, async () => {
    const id = postIdOrThrow((await params).id);
    return NextResponse.json({ post: await unschedulePost(id) });
  });
}
