import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { withApiKey } from "@/lib/publicApi/http";
import { buildMcpServer } from "@/lib/publicApi/mcp";
import * as operations from "@/lib/publicApi/operations";

export const dynamic = "force-dynamic";

// /api/v1/mcp: the public API as an MCP server (Streamable HTTP), for AI
// assistants. Same API key and same operations as the REST routes
// (src/lib/publicApi/mcp.ts, docs/mcp.mdx).
//
// Stateless: every POST gets its own server and transport, inside the
// organization scope withApiKey opens, and nothing outlives the request, so
// it works on any number of instances. JSON responses, not SSE: the
// transport answers once every tool call in the request has finished, which
// keeps the tools inside that scope.
export async function POST(req: NextRequest) {
  return withApiKey(req, async (caller) => {
    const server = buildMcpServer(operations, caller.scopes);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      await server.close();
    }
  });
}

// A stateless server has no server-to-client stream (GET) and no session to end (DELETE).
function methodNotAllowed() {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless, send JSON-RPC as POST" }, id: null },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
