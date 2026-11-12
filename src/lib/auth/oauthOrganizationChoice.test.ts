import { describe, expect, test } from "bun:test";
import { OAUTH_ORGANIZATION_COOKIE, hasChosenOrganization, organizationChoiceValue } from "./oauthOrganizationChoice";

const cookie = (value: string) => `other=1; ${OAUTH_ORGANIZATION_COOKIE}=${encodeURIComponent(value)}; theme=dark`;

describe("hasChosenOrganization", () => {
  test("a choice made in this session for its active organization counts", () => {
    expect(hasChosenOrganization(cookie(organizationChoiceValue("s1", "org-a")), "s1", "org-a")).toBe(true);
  });

  test("another session's, another organization's, or none does not", () => {
    expect(hasChosenOrganization(cookie(organizationChoiceValue("s2", "org-a")), "s1", "org-a")).toBe(false);
    expect(hasChosenOrganization(cookie(organizationChoiceValue("s1", "org-b")), "s1", "org-a")).toBe(false);
    expect(hasChosenOrganization("other=1", "s1", "org-a")).toBe(false);
    expect(hasChosenOrganization(null, "s1", "org-a")).toBe(false);
    expect(hasChosenOrganization(cookie(organizationChoiceValue("s1", "org-a")), "s1", null)).toBe(false);
  });
});
