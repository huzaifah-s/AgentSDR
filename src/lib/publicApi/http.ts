import "server-only";

import { NextResponse } from "next/server";
import { runInOrganization } from "@/lib/tenancy/scope";
import { organizationForApiKey } from "./keys";
import { PublicApiError } from "./requests";

/**
 * The first line of every public API route (/api/v1/*, public in proxy.ts,
 * so this is the only gate). Resolves the organization from the request's
 * API key and runs `fn` inside its scope, so every query keeps its inOrg
 * filter and a key never reaches another organization's data.
 */
export async function withApiKey(request: Request, fn: () => Promise<Response>): Promise<Response> {
  try {
    const caller = await organizationForApiKey(request.headers.get("authorization"));
    if (!caller) {
      return NextResponse.json(
        { error: "Missing or invalid API key. Send it as Authorization: Bearer <key> (Settings, API keys)." },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
      );
    }
    return await runInOrganization(caller.organizationId, fn);
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A campaign id from the path. Anything that is not a uuid is a 404, like an unknown id. */
export function campaignIdParam(id: string): string {
  if (!UUID.test(id)) throw new PublicApiError(404, "Campaign not found");
  return id;
}
