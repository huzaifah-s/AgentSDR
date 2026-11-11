import { describe, expect, test } from "bun:test";
import { normalizePersonEdit } from "./editPerson";

describe("normalizePersonEdit", () => {
  test("normalizes identities and clears empty fields", () => {
    expect(normalizePersonEdit({
      firstName: " Jane ",
      lastName: "",
      email: " Jane@Acme.com ",
      linkedinUrl: "https://www.linkedin.com/in/Jane-Doe/",
      phone: "",
      title: "  ",
      companyName: "",
      companyDomain: "",
      notes: "",
    })).toEqual({
      firstName: "Jane",
      lastName: null,
      email: "jane@acme.com",
      linkedinUrl: "jane-doe",
      phone: null,
      title: null,
      companyName: null,
      companyDomain: null,
      notes: null,
    });
  });

  test("keeps an email or LinkedIn identity", () => {
    expect(() => normalizePersonEdit({ email: "", linkedinUrl: "" })).toThrow(/email address or a LinkedIn URL/);
    expect(() => normalizePersonEdit({ email: "not-an-email" })).toThrow(/Invalid email/);
    expect(() => normalizePersonEdit({ email: "jane@acme.com", linkedinUrl: "https://example.com/x" })).toThrow(/Invalid LinkedIn/);
  });

  test("refuses a phone number that does not parse instead of erasing the old one", () => {
    expect(normalizePersonEdit({ email: "jane@acme.com", phone: "+91 98765 43210" }).phone).toBe("+919876543210");
    expect(() => normalizePersonEdit({ email: "jane@acme.com", phone: "12345" })).toThrow(/Invalid phone/);
  });

  test("resolves the company domain the way upsertPerson does", () => {
    expect(normalizePersonEdit({ email: "jane@gmail.com", companyName: "Acme", companyDomain: "https://www.acme.com" }).companyDomain).toBe("acme.com");
    // A name alone takes a work email's domain…
    expect(normalizePersonEdit({ email: "jane@acme.com", companyName: "Acme" }).companyDomain).toBe("acme.com");
    // …but not a public mailbox's, and nothing without a name.
    expect(normalizePersonEdit({ email: "jane@gmail.com", companyName: "Acme" }).companyDomain).toBeNull();
    expect(normalizePersonEdit({ email: "jane@acme.com" }).companyDomain).toBeNull();
    expect(() => normalizePersonEdit({ email: "jane@acme.com", companyDomain: "Acme Inc" })).toThrow(/Invalid company domain/);
  });
});
