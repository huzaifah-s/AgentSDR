import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { postIdOrThrow, withPostsRoute } from "@/lib/linkedin/posts/http";
import { PostApiError, postImageKeyFor, removePostImage } from "@/lib/linkedin/posts/posts.server";
import { isImageId } from "@/lib/linkedin/posts/requests";
import { presignPostImage } from "@/lib/linkedin/posts/storage";

type Params = { params: Promise<{ id: string; imageId: string }> };

function imageIdOrThrow(imageId: string): string {
  if (!isImageId(imageId)) throw new PostApiError(404, "Image not found");
  return imageId.toLowerCase();
}

/** GET: the image, through a short-lived R2 link (never a bucket URL). */
export async function GET(request: NextRequest, { params }: Params) {
  return withPostsRoute(request, async () => {
    const { id, imageId } = await params;
    const key = await postImageKeyFor(postIdOrThrow(id), imageIdOrThrow(imageId));
    const url = await presignPostImage(key);
    return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, max-age=1800" } });
  });
}

/** DELETE: remove an image from a draft, scheduled or failed post. */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withPostsRoute(request, async () => {
    const { id, imageId } = await params;
    return NextResponse.json({ post: await removePostImage(postIdOrThrow(id), imageIdOrThrow(imageId)) });
  });
}
