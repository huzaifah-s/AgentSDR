import { describe, expect, test } from "bun:test";
import { API_KEY_PREFIX, apiKeyFromAuthorization, createApiKeySecret, hashApiKey } from "./token";

describe("API keys", () => {
  test("a new key is random, prefixed, and stored only as its hash", () => {
    const a = createApiKeySecret();
    const b = createApiKeySecret();
    expect(a.key).not.toBe(b.key);
    expect(a.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(a.hash).toBe(hashApiKey(a.key));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.key);
    expect(a.key.startsWith(a.prefix)).toBe(true);
    expect(a.prefix.length).toBeLessThan(a.key.length / 2);
  });

  test("reads the key from a Bearer header and ignores anything else", () => {
    const { key } = createApiKeySecret();
    expect(apiKeyFromAuthorization(`Bearer ${key}`)).toBe(key);
    expect(apiKeyFromAuthorization(`bearer ${key}`)).toBe(key);
    expect(apiKeyFromAuthorization(null)).toBeNull();
    expect(apiKeyFromAuthorization("")).toBeNull();
    expect(apiKeyFromAuthorization(key)).toBeNull();
    expect(apiKeyFromAuthorization("Bearer some-other-token")).toBeNull();
    expect(apiKeyFromAuthorization(`Bearer ${key} extra`)).toBeNull();
  });
});
