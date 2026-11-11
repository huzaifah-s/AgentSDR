import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse } from "@/lib/auth/context";
import { publishScheduledLinkedinPosts } from "@/jobs/publishLinkedinPosts";
import { resolveJobCaller } from "@/lib/linkedin/organizations.server";
import { runPlatformJobForCron } from "@/lib/scheduler/endpoint";

/**
 * Publish the scheduled LinkedIn posts that are due. The cron (Bearer
 * CRON_SECRET) runs every organization, once per slot shared with the
 * in-process scheduler (`?force=1` for a deliberate re-run); a signed-in
 * member runs only their own organization's.
 */
export async function POST(req: NextRequest) {
  try {
    const { organizationId } = await resolveJobCaller(req);
    if (!organizationId) return await runPlatformJobForCron("linkedin-publish-posts", req);
    const summary = await publishScheduledLinkedinPosts({ organizationId });
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
