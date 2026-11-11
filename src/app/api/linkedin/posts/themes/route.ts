import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { postThemes } from "@/lib/linkedin/posts/ai.server";
import { withPostsRoute } from "@/lib/linkedin/posts/http";

/**
 * POST: "What prospects say" (Phase 4). Reads the organization's inbound
 * replies and call transcripts from the last 30 days and groups them into
 * 3–6 themes with one model call. Saves nothing; each theme comes back
 * sealed, for /generate to write from. Every member may use it: they already
 * see the CRM. 409 when Unipile or OpenRouter is not connected.
 */
export async function POST(request: NextRequest) {
  return withPostsRoute(request, async () => NextResponse.json(await postThemes()));
}
