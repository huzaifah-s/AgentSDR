import { createHash, randomBytes } from "node:crypto";

/**
 * The shape of an API key. The database only ever holds its SHA-256 hash
 * (api_keys.key_hash), the same rule as the recorder's per-call token
 * (src/lib/calls/token.ts): a database read alone can never call the API.
 */

/** Marks the string as an AgentSDR key, so a leaked one is recognisable in logs and secret scanners. */
export const API_KEY_PREFIX = "asdr_";

/** How much of the key is kept in clear (api_keys.key_prefix) to tell keys apart in Settings. */
const SHOWN_LENGTH = API_KEY_PREFIX.length + 6;

export function createApiKeySecret(): { key: string; hash: string; prefix: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, SHOWN_LENGTH) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** The key from `Authorization: Bearer <key>`, or null when the header is missing or is not one of ours. */
export function apiKeyFromAuthorization(header: string | null): string | null {
  const token = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1] ?? null;
  return token && token.startsWith(API_KEY_PREFIX) ? token : null;
}
