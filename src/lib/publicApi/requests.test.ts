import { describe, expect, test } from "bun:test";
import { MAX_LEADS_PER_REQUEST, PublicApiError, assertCampaignWritesAllowed, parseLeadsRequest, parseStopRequest } from "./requests";

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PublicApiError && error.status === 400) return error.message;
    throw error;
  }
  throw new Error("expected a 400");
}

describe("parseLeadsRequest", () => {
  test("maps named fields and keeps custom fields as merge fields", () => {
    const [row] = parseLeadsRequest({
      leads: [{
        email: "  Maker@Example.com ",
        firstName: "Asha",
        lastName: "Rao",
        company: "Example Inc",
        companyDomain: "example.com",
        title: "Founder",
        customFields: { productName: "Example", upvotes: 42, featured: true, empty: "", missing: null },
      }],
    });
    expect(row).toEqual({
      email: "maker@example.com",
      firstName: "Asha",
      lastName: "Rao",
      title: "Founder",
      company: "Example Inc",
      domain: "example.com",
      companyLinkedinUrl: null,
      linkedinUrl: null,
      customFields: { productName: "Example", upvotes: "42", featured: "true" },
    });
  });

  test("leaves an invalid email to the import, which reports it per lead", () => {
    expect(parseLeadsRequest({ leads: [{ email: "not-an-email" }, {}] }).map((r) => r.email)).toEqual(["not-an-email", ""]);
  });

  test("refuses a misspelt field instead of dropping it", () => {
    expect(refusal(() => parseLeadsRequest({ leads: [{ email: "a@b.co", frstName: "A" }] }))).toContain("leads[0].frstName");
  });

  test("refuses a custom field name that cannot be a merge field", () => {
    expect(refusal(() => parseLeadsRequest({ leads: [{ email: "a@b.co", customFields: { "product name": "x" } }] }))).toContain("product name");
    expect(refusal(() => parseLeadsRequest({ leads: [{ email: "a@b.co", customFields: { nested: { a: 1 } } }] }))).toContain("nested");
  });

  test("refuses a body that is not a list of leads, an empty one, or one too long", () => {
    expect(refusal(() => parseLeadsRequest(null))).toContain("leads");
    expect(refusal(() => parseLeadsRequest({ leads: {} }))).toContain("leads");
    expect(refusal(() => parseLeadsRequest({ leads: [] }))).toContain("empty");
    const many = Array.from({ length: MAX_LEADS_PER_REQUEST + 1 }, (_, i) => ({ email: `p${i}@example.com` }));
    expect(refusal(() => parseLeadsRequest({ leads: many }))).toContain(String(MAX_LEADS_PER_REQUEST));
  });

  test("refuses a non-string field", () => {
    expect(refusal(() => parseLeadsRequest({ leads: [{ email: "a@b.co", firstName: 7 }] }))).toContain("leads[0].firstName");
  });
});

describe("parseStopRequest", () => {
  test("trims and lowercases", () => {
    expect(parseStopRequest({ emails: [" A@Example.com", "b@example.com"] })).toEqual(["a@example.com", "b@example.com"]);
  });

  test("refuses anything but a non-empty list of strings", () => {
    expect(refusal(() => parseStopRequest({}))).toContain("emails");
    expect(refusal(() => parseStopRequest({ emails: [] }))).toContain("empty");
    expect(refusal(() => parseStopRequest({ emails: ["a@b.co", 3] }))).toContain("emails[1]");
    expect(refusal(() => parseStopRequest({ emails: ["  "] }))).toContain("emails[0]");
  });
});

describe("assertCampaignWritesAllowed", () => {
  test("passes when nothing is paused", () => {
    expect(() => assertCampaignWritesAllowed({})).not.toThrow();
  });

  for (const env of [{ PAUSE_CAMPAIGN_MUTATIONS: "true" }, { PEOPLE_MIGRATION_MODE: "1" }]) {
    test(`is a 503 under ${Object.keys(env)[0]}`, () => {
      try {
        assertCampaignWritesAllowed(env);
      } catch (error) {
        expect(error).toBeInstanceOf(PublicApiError);
        expect((error as PublicApiError).status).toBe(503);
        return;
      }
      throw new Error("expected a 503");
    });
  }
});
