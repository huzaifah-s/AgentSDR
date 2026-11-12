import { describe, expect, test } from "bun:test";
import { withNativeDefault } from "./oauthRegistration";

describe("withNativeDefault", () => {
  test("loopback http redirects without application_type register as native", () => {
    for (const uri of ["http://localhost:33418/callback", "http://127.0.0.1:53682/callback", "http://[::1]/cb", "http://localhost"]) {
      expect(withNativeDefault({ redirect_uris: [uri] })).toEqual({ redirect_uris: [uri], application_type: "native" });
    }
  });

  test("anything else is left to the plugin", () => {
    const https = { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };
    expect(withNativeDefault(https)).toBe(https);
    const mixed = { redirect_uris: ["http://localhost:1/cb", "https://example.com/cb"] };
    expect(withNativeDefault(mixed)).toBe(mixed);
    const explicit = { redirect_uris: ["http://localhost:1/cb"], application_type: "web" };
    expect(withNativeDefault(explicit)).toBe(explicit);
    const lookalike = { redirect_uris: ["http://localhost.evil.example/cb"] };
    expect(withNativeDefault(lookalike)).toBe(lookalike);
    expect(withNativeDefault({ redirect_uris: [] })).toEqual({ redirect_uris: [] });
    expect(withNativeDefault(null)).toBe(null);
    expect(withNativeDefault(["x"])).toEqual(["x"]);
  });
});
