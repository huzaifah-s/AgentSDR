import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/lib/auth/server";

// RFC 8414 metadata for BraintreeSDR's OAuth authorization server
// (src/lib/auth/oauthProvider.ts). Better Auth is mounted at /api/auth, so the
// issuer has a path: clients look for /.well-known/oauth-authorization-server/api/auth,
// and some for the bare /.well-known/oauth-authorization-server. Both answer
// the same document. Public in proxy.ts.
export const GET = oauthProviderAuthServerMetadata(auth);
