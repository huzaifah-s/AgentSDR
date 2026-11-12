import { NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/lib/auth/oauthProvider";

// RFC 9728 metadata for the MCP endpoint: which authorization server issues
// its tokens and which scopes exist. A 401 from /api/v1/mcp names
// /.well-known/oauth-protected-resource/api/v1/mcp; the bare path answers
// the same, since it is the only protected resource. Public in proxy.ts.
export function GET() {
  return NextResponse.json(protectedResourceMetadata(), {
    headers: { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" },
  });
}
