import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { MAX_POST_IMAGE_BYTES } from "@/lib/linkedin/posts/contract";
import { postIdOrThrow, withPostsRoute } from "@/lib/linkedin/posts/http";
import { addPostImage, assertCanAddImage, PostApiError } from "@/lib/linkedin/posts/posts.server";
import { validateImageUpload } from "@/lib/linkedin/posts/requests";
import { requirePlatformCredentials } from "@/lib/platform/credentials";

/** POST (multipart, field `file`): add one image to a post. Needs the R2 integration. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withPostsRoute(request, async () => {
    const id = postIdOrThrow((await params).id);
    await requirePlatformCredentials("r2");
    const { existingCount } = await assertCanAddImage(id);

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_POST_IMAGE_BYTES + 64 * 1024) {
      throw new PostApiError(413, `An image can be at most ${MAX_POST_IMAGE_BYTES / (1024 * 1024)} MB.`);
    }
    let file: FormDataEntryValue | null;
    try {
      file = (await request.formData()).get("file");
    } catch {
      throw new PostApiError(400, "Expected a file upload");
    }
    if (!(file instanceof File)) throw new PostApiError(400, "Expected a file upload");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const upload = validateImageUpload({
      declaredType: file.type,
      fileName: file.name,
      head: bytes.subarray(0, 16),
      size: bytes.byteLength,
      existingCount,
    });
    if (!upload.ok) throw new PostApiError(400, upload.error);
    return NextResponse.json({ post: await addPostImage(id, upload.value, bytes) }, { status: 201 });
  });
}
