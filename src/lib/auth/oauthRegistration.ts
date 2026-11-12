/**
 * One compatibility rule for OAuth dynamic client registration
 * (/api/auth/oauth2/register): a registration that does not say
 * `application_type` and whose redirect URIs are all plain-http loopback
 * (localhost, 127.0.0.1, [::1]) is a desktop or command-line app, so it is
 * registered as `native` (RFC 8252), not the plugin's default `web`, which
 * would refuse those URIs. Desktop MCP clients register like this.
 *
 * It grants nothing a client could not ask for itself by sending
 * `application_type: "native"`. Pure, so it is tested on its own.
 */

const LOOPBACK_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

export function withNativeDefault(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const registration = body as Record<string, unknown>;
  if (registration.application_type !== undefined) return body;
  const uris = registration.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return body;
  if (!uris.every((uri) => typeof uri === "string" && LOOPBACK_HTTP.test(uri))) return body;
  return { ...registration, application_type: "native" };
}
