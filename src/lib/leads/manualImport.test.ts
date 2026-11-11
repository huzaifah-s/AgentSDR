import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeManualPersonInput } from "./manualImport";

describe("manual People import", () => {
  test("normalizes both identities on the same Person input", () => {
    assert.deepEqual(normalizeManualPersonInput({
      email: " Jane@Example.COM ",
      linkedinUrl: "https://www.linkedin.com/in/Jane-Doe/",
      fullName: " Jane Doe ",
    }), {
      email: "jane@example.com",
      linkedinUrl: "jane-doe",
      firstName: null,
      lastName: null,
      fullName: "Jane Doe",
      title: null,
      companyName: null,
      companyDomain: null,
      notes: null,
      phone: null,
    });
  });

  test("normalizes a valid phone number and drops an invalid one without failing the row", () => {
    assert.equal(normalizeManualPersonInput({ email: "jane@example.com", phone: "+91 98765 43210" }).phone, "+919876543210");
    assert.equal(normalizeManualPersonInput({ email: "jane@example.com", phone: "not a phone number" }).phone, null);
    assert.equal(normalizeManualPersonInput({ email: "jane@example.com" }).phone, null);
  });

  test("requires a valid Email or LinkedIn identity", () => {
    assert.throws(() => normalizeManualPersonInput({}), /Email or LinkedIn URL/);
    assert.throws(() => normalizeManualPersonInput({ email: "not-an-email" }), /Invalid email/);
  });

  test("accepts a company domain given as a URL and rejects one that is not a domain", () => {
    assert.equal(normalizeManualPersonInput({ email: "jane@example.com", companyDomain: "https://www.Acme.com/about" }).companyDomain, "https://www.Acme.com/about");
    assert.throws(() => normalizeManualPersonInput({ email: "jane@example.com", companyDomain: "Acme Inc" }), /Invalid company domain/);
    assert.doesNotThrow(() => normalizeManualPersonInput({ email: "jane@example.com", companyDomain: "  " }));
  });

  test("rejects one malformed supplied identity even when the other is valid", () => {
    assert.throws(() => normalizeManualPersonInput({
      email: "jane@example.com",
      linkedinUrl: "https://example.com/not-linkedin",
    }), /Invalid LinkedIn/);
  });
});
