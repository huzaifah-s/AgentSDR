import "server-only";

import { NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext, type OrgContext } from "@/lib/auth/context";
import { isPlatformNotConnectedError, requirePlatformCredentials } from "@/lib/platform/credentials";
import { PostApiError } from "./posts.server";
import { PostPublishRefusedError } from "./publish";
import { isPostId } from "./requests";

/**
 * The frame every /api/linkedin/posts route runs in: the caller's
 * organization scope, Unipile connected (409 otherwise, like the rest of
 * LinkedIn), and one mapping of the posts errors to responses.
 */
export async function withPostsRoute(
  request: { headers: Headers },
  fn: (ctx: OrgContext) => Promise<Response>,
): Promise<Response> {
  try {
    return await withOrgContext(request, async (ctx) => {
      await requirePlatformCredentials("unipile");
      return fn(ctx);
    });
  } catch (error) {
    return postsErrorResponse(error);
  }
}

export function postsErrorResponse(error: unknown): Response {
  const auth = authContextErrorResponse(error);
  if (auth) return auth;
  if (isPlatformNotConnectedError(error)) {
    return NextResponse.json({ error: error.message, code: "PLATFORM_NOT_CONNECTED", platform: error.platform }, { status: 409 });
  }
  if (error instanceof PostApiError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof PostPublishRefusedError) {
    return NextResponse.json({ error: error.refusal.message }, { status: error.refusal.status });
  }
  console.error("[linkedin/posts] request failed", error);
  return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
}

/** A post id from the path; anything that is not a uuid is simply not found. */
export function postIdOrThrow(id: string): string {
  if (!isPostId(id)) throw new PostApiError(404, "Post not found");
  return id.toLowerCase();
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new PostApiError(400, "Expected a JSON body");
  }
}
