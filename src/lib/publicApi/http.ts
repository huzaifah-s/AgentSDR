import "server-only";

import { NextResponse } from "next/server";
import { runInOrganization } from "@/lib/tenancy/scope";
import type { ApiCaller, ApiScope } from "./access";
import { organizationForApiKey } from "./keys";
import { callerForOAuthToken } from "./oauth";
import { API_KEY_PREFIX } from "./token";
import { PublicApiError } from "./requests";

/**
 * The first line of every public API route (/api/v1/*, public in proxy.ts,
 * so this is the only gate). Resolves the organization from the request's
 * credential and runs `fn` inside its scope, so every query keeps its inOrg
 * filter and a caller never reaches another organization's data.
 *
 * The credential is an API key, or, where `oauth` is set (the MCP route
 * only), an OAuth access token from a connected app
 * (src/lib/publicApi/oauth.ts). A 401 there names the protected resource
 * metadata, which is how an MCP client finds where to sign in.
 *
 * `scope` is what the route needs (src/lib/publicApi/access.ts): a caller
 * without it gets 403 before `fn` runs. The MCP route asks for none and
 * instead offers only the tools the caller's scopes allow.
 */
export async function withApiKey(
  request: Request,
  fn: (caller: ApiCaller) => Promise<Response>,
  options: { scope?: ApiScope; oauth?: { resourceMetadataUrl: string } } = {},
): Promise<Response> {
  try {
    const caller = await callerFor(request.headers.get("authorization"), Boolean(options.oauth));
    if (!caller) {
      return NextResponse.json(
        {
          error: options.oauth
            ? "Missing or invalid credential. Connect through OAuth, or send an API key as Authorization: Bearer <key> (Settings, API keys)."
            : "Missing or invalid API key. Send it as Authorization: Bearer <key> (Settings, API keys).",
        },
        {
          status: 401,
          headers: {
            "WWW-Authenticate": options.oauth ? `Bearer resource_metadata="${options.oauth.resourceMetadataUrl}"` : "Bearer",
          },
        },
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

/** An `asdr_` key is always an API key; anything else is an OAuth token, where those are accepted. */
async function callerFor(authorization: string | null, acceptOAuth: boolean): Promise<ApiCaller | null> {
  const token = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "")?.[1] ?? null;
  if (!token) return null;
  if (token.startsWith(API_KEY_PREFIX)) return organizationForApiKey(authorization);
  return acceptOAuth ? callerForOAuthToken(token) : null;
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
