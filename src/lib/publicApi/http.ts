import "server-only";

import { NextResponse } from "next/server";
import { runInOrganization } from "@/lib/tenancy/scope";
import type { ApiCaller, ApiScope } from "./access";
import { organizationForApiKey } from "./keys";
import { PublicApiError } from "./requests";

/**
 * The first line of every public API route (/api/v1/*, public in proxy.ts,
 * so this is the only gate). Resolves the organization from the request's
 * API key and runs `fn` inside its scope, so every query keeps its inOrg
 * filter and a key never reaches another organization's data.
 *
 * `scope` is what the route needs (src/lib/publicApi/access.ts): a caller
 * without it gets 403 before `fn` runs. The MCP route asks for none and
 * instead offers only the tools the caller's scopes allow.
 */
export async function withApiKey(
  request: Request,
  fn: (caller: ApiCaller) => Promise<Response>,
  options: { scope?: ApiScope } = {},
): Promise<Response> {
  try {
    const caller = await organizationForApiKey(request.headers.get("authorization"));
    if (!caller) {
      return NextResponse.json(
        { error: "Missing or invalid API key. Send it as Authorization: Bearer <key> (Settings, API keys)." },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
      );
    }
    if (options.scope && !caller.scopes.has(options.scope)) {
      return NextResponse.json({ error: missingScopeMessage(options.scope) }, { status: 403 });
    }
    return await runInOrganization(caller.organizationId, () => fn(caller));
  } catch (error) {
    if (error instanceof PublicApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("[public-api]", request.method, new URL(request.url).pathname, error);
    return NextResponse.json({ error: "Something went wrong on the server" }, { status: 500 });
  }
}

/** The request's JSON body; a 400 when it is not JSON. */
export async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new PublicApiError(400, "The body must be JSON (Content-Type: application/json)");
  }
}

function missingScopeMessage(scope: ApiScope): string {
  return scope === "campaigns:write"
    ? "This API key is read-only. Adding and stopping leads needs a read-and-write key (Settings, API keys)."
    : `This credential does not allow ${scope}`;
}
