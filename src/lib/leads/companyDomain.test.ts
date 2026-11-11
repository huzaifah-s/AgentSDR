import { describe, expect, test } from "bun:test";
import { parseCompanyDomain } from "./identity";

describe("parseCompanyDomain", () => {
  test("normalizes a typed domain or website", () => {
    expect(parseCompanyDomain("acme.com")).toBe("acme.com");
    expect(parseCompanyDomain(" https://www.Acme.co.uk/about?x=1 ")).toBe("acme.co.uk");
    expect(parseCompanyDomain("sub.my-company.io")).toBe("sub.my-company.io");
  });

  test("refuses what is not a domain", () => {
    expect(parseCompanyDomain("Acme Inc")).toBeNull();
    expect(parseCompanyDomain("acme")).toBeNull();
    expect(parseCompanyDomain("-acme.com")).toBeNull();
    expect(parseCompanyDomain("acme.c")).toBeNull();
    expect(parseCompanyDomain("")).toBeNull();
    expect(parseCompanyDomain(null)).toBeNull();
  });
});
