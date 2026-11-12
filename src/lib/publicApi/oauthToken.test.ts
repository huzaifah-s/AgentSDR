import { describe, expect, test } from "bun:test";
import { createHash } from "@better-auth/utils/hash";
import { base64Url } from "@better-auth/utils/base64";
import { accessTokenDecision, hashOpaqueToken, type AccessTokenRow } from "./oauthToken";

const RESOURCE = "https://app.example.com/api/v1/mcp";
const NOW = new Date("2026-11-12T10:00:00Z");
const ORG = "0b6a3c1e-1111-4222-8333-444455556666";
const LATER = new Date("2026-11-12T11:00:00Z");

function token(overrides: Partial<AccessTokenRow> = {}): AccessTokenRow {
  return {
    clientId: "client-1",
    userId: "user-1",
    referenceId: ORG,
    resources: [RESOURCE],
    scopes: ["campaigns:read", "crm:read", "offline_access"],
    expiresAt: LATER,
    revoked: null,
    confirmation: null,
    ...overrides,
  };
}

function decide(row: AccessTokenRow | null, extra: { client?: { disabled: boolean | null } | null } = {}) {
  return accessTokenDecision({
    token: row,
    client: extra.client === undefined ? { disabled: false } : extra.client,
    resource: RESOURCE,
    now: NOW,
  });
}

describe("hashOpaqueToken", () => {
  test("matches the plugin's own hasher (SHA-256, base64url, no padding)", async () => {
    const value = "abcDEF123-_~token";
    const digest = await createHash("SHA-256").digest(new TextEncoder().encode(value));
    expect(hashOpaqueToken(value)).toBe(base64Url.encode(new Uint8Array(digest), { padding: false }));
  });
});

describe("accessTokenDecision", () => {
  test("a live token for this resource acts as its person in its organization, with its API scopes only", () => {
    const decision = decide(token());
    expect(decision).toEqual({
      ok: true,
      userId: "user-1",
      organizationId: ORG,
      clientId: "client-1",
      scopes: new Set(["campaigns:read", "crm:read"]),
    });
  });

  test("unknown, expired and revoked tokens are refused", () => {
    expect(decide(null)).toEqual({ ok: false, reason: "unknown token" });
    expect(decide(token({ expiresAt: NOW }))).toEqual({ ok: false, reason: "expired" });
    expect(decide(token({ expiresAt: null }))).toEqual({ ok: false, reason: "expired" });
    expect(decide(token({ revoked: NOW }))).toEqual({ ok: false, reason: "revoked" });
  });

  test("a sender-constrained token is refused: this server checks no DPoP proof", () => {
    expect(decide(token({ confirmation: { jkt: "x" } }))).toEqual({ ok: false, reason: "sender-constrained token" });
  });

  test("a disabled or deleted client's tokens stop working", () => {
    expect(decide(token(), { client: { disabled: true } })).toEqual({ ok: false, reason: "client disabled or gone" });
    expect(decide(token(), { client: null })).toEqual({ ok: false, reason: "client disabled or gone" });
  });

  test("a token for another resource is refused; one with no resource is ours", () => {
    expect(decide(token({ resources: ["https://other.example.com/mcp"] }))).toEqual({ ok: false, reason: "issued for another resource" });
    expect(decide(token({ resources: null })).ok).toBe(true);
    expect(decide(token({ resources: [] })).ok).toBe(true);
  });

  test("no person, no organization or no usable scope is refused", () => {
    expect(decide(token({ userId: null }))).toEqual({ ok: false, reason: "no user" });
    expect(decide(token({ referenceId: null }))).toEqual({ ok: false, reason: "no organization" });
    expect(decide(token({ referenceId: "not-an-organization-id" }))).toEqual({ ok: false, reason: "no organization" });
    expect(decide(token({ scopes: ["offline_access", "openid"] }))).toEqual({ ok: false, reason: "no usable scope" });
  });
});
