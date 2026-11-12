/**
 * What a caller of the public API (REST /api/v1/* and the MCP tools at
 * /api/v1/mcp) may do. Client-safe: Settings imports the labels.
 *
 * Scopes are the unit. An API key has an access level, which stands for a
 * fixed set of scopes. An OAuth token (docs/mcp/plan.md, phase 2) carries
 * scopes of its own. Routes and tools check scopes, never the credential
 * type.
 */

export const API_SCOPES = ["campaigns:read", "campaigns:write", "crm:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** What each scope allows, in the words a person reads when granting it. */
export const API_SCOPE_LABELS: Readonly<Record<ApiScope, string>> = {
  "campaigns:read": "See email campaigns, their numbers and their leads' status",
  "campaigns:write": "Add leads to email campaigns and stop a lead's sequence",
  "crm:read": "See the CRM's Action required queue, including the latest reply from each lead",
};

export const API_KEY_ACCESS = ["read_write", "read"] as const;
export type ApiKeyAccess = (typeof API_KEY_ACCESS)[number];

export const API_KEY_ACCESS_LABELS: Readonly<Record<ApiKeyAccess, string>> = {
  read_write: "Read and write",
  read: "Read only",
};

export function isApiKeyAccess(value: unknown): value is ApiKeyAccess {
  return typeof value === "string" && (API_KEY_ACCESS as readonly string[]).includes(value);
}

const KEY_SCOPES: Readonly<Record<ApiKeyAccess, readonly ApiScope[]>> = {
  read: ["campaigns:read", "crm:read"],
  read_write: ["campaigns:read", "campaigns:write", "crm:read"],
};

export function scopesForKeyAccess(access: ApiKeyAccess): ReadonlySet<ApiScope> {
  return new Set(KEY_SCOPES[access]);
}

/** Who is calling, once their credential checked out. */
export type ApiCaller = {
  organizationId: string;
  scopes: ReadonlySet<ApiScope>;
  credential: { kind: "api_key"; keyId: string; access: ApiKeyAccess };
};
