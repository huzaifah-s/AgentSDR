import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/server";
import { withNativeDefault } from "@/lib/auth/oauthRegistration";

// Better Auth's endpoints: /api/auth/sign-in/*, /sign-up/*, /sign-out,
// /get-session, /organization/*, /callback/google, … and the OAuth
// provider's /oauth2/* (src/lib/auth/oauthProvider.ts). Public in proxy.ts.
const handler = toNextJsHandler(auth);

export const GET = handler.GET;

export async function POST(request: Request) {
  if (new URL(request.url).pathname === "/api/auth/oauth2/register") return handler.POST(await nativeDefaultRegistration(request));
  return handler.POST(request);
}

/** A desktop client's registration without application_type becomes native (src/lib/auth/oauthRegistration.ts). */
async function nativeDefaultRegistration(request: Request): Promise<Request> {
  const text = await request.text();
  let body = text;
  try {
    body = JSON.stringify(withNativeDefault(JSON.parse(text)));
  } catch {
    // Not JSON: hand it on unchanged and let the plugin refuse it.
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body });
}
