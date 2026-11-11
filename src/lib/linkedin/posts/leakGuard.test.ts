import { describe, expect, test } from "bun:test";
import { companyCore, describeLeaks, findLeaks, leakTerms, redactLeaks } from "./leakGuard";

const priya = {
  firstName: "Priya",
  lastName: "Shah",
  fullName: "Priya Shah",
  email: "Priya.Shah@zetalabs.io",
  phone: "+919876543210",
  linkedinUrl: "priyashah88",
  companyName: "Zeta Labs Pvt. Ltd.",
  companyDomain: "zetalabs.io",
};
const terms = leakTerms([priya, { firstName: "Will", lastName: "Best", companyName: "Acme Inc", companyDomain: "gmail.com" }]);
const leaks = (text: string) => findLeaks(text, terms);

describe("leakTerms", () => {
  test("names, company core, domain, email, phone and slug; no first name alone", () => {
    const values = terms.map((term) => `${term.kind}:${term.value}`);
    expect(values).toContain("name:Priya Shah");
    expect(values).toContain("name:Shah Priya");
    expect(values).toContain("name:Shah");
    expect(values).toContain("company:Zeta Labs");
    expect(values).toContain("company:zetalabs.io");
    expect(values).toContain("email:priya.shah@zetalabs.io");
    expect(values).toContain("phone:76543210");
    expect(values).toContain("profile:priyashah88");
    expect(values).not.toContain("name:Priya");
    expect(values).not.toContain("name:Will");
    // A mail provider's domain names nobody.
    expect(values).not.toContain("company:gmail.com");
  });

  test("drops duplicates and empty people", () => {
    expect(leakTerms([priya, priya]).length).toBe(leakTerms([priya]).length);
    expect(leakTerms([{}])).toEqual([]);
  });

  test("companyCore strips legal suffixes but keeps a one-word name", () => {
    expect(companyCore("Zeta Labs Pvt. Ltd.")).toBe("Zeta Labs");
    expect(companyCore("Acme, Inc.")).toBe("Acme");
    expect(companyCore("Limited")).toBe("Limited");
  });
});

describe("findLeaks", () => {
  test("a clean post passes", () => {
    expect(leaks("Most teams we talk to say onboarding takes too long. Here is what we changed.")).toEqual([]);
  });

  test("a full name, in any case and either order, is reported once", () => {
    expect(leaks("A chat with priya shah last week")).toEqual([{ kind: "name", value: "Priya Shah" }]);
    expect(leaks("Shah, Priya told me")).toEqual([{ kind: "name", value: "Shah Priya" }]);
  });

  test("diacritics do not hide a name", () => {
    const josé = leakTerms([{ firstName: "José", lastName: "Núñez" }]);
    expect(findLeaks("Thanks Jose Nunez!", josé)).toEqual([{ kind: "name", value: "José Núñez" }]);
  });

  test("a surname alone only as a name", () => {
    expect(leaks("Mr Shah asked about pricing")).toEqual([{ kind: "name", value: "Shah" }]);
    expect(leaks("the best way to start")).toEqual([]);
    expect(leaks("Best regards")).toEqual([{ kind: "name", value: "Best" }]);
  });

  test("on word boundaries only", () => {
    expect(leaks("Shahrukh films")).toEqual([]);
    expect(leaks("A zeta labsfest")).toEqual([]);
  });

  test("companies by core name and domain", () => {
    expect(leaks("we helped zeta labs ship faster")).toEqual([{ kind: "company", value: "Zeta Labs" }]);
    expect(leaks("Visit zetalabs.io today")).toEqual([{ kind: "company", value: "zetalabs.io" }]);
    expect(leaks("Acme cut their costs")).toEqual([{ kind: "company", value: "Acme" }]);
    expect(leaks("the acme of efficiency")).toEqual([]);
  });

  test("email any case, phone however grouped", () => {
    const found = leaks("Write to PRIYA.SHAH@ZETALABS.IO or call 98765 43210");
    expect(found).toContainEqual({ kind: "email", value: "priya.shah@zetalabs.io" });
    expect(found).toContainEqual({ kind: "phone", value: "76543210" });
    expect(leaks("+91 (987) 654-3210")).toContainEqual({ kind: "phone", value: "76543210" });
    expect(leaks("We grew 76,543 users")).toEqual([]);
  });

  test("a profile slug", () => {
    expect(leaks("linkedin.com/in/priyashah88")).toContainEqual({ kind: "profile", value: "priyashah88" });
  });

  test("no terms, nothing found", () => {
    expect(findLeaks("Priya Shah", [])).toEqual([]);
  });
});

describe("redactLeaks", () => {
  test("replaces every term with a placeholder", () => {
    const text = "Hi, Priya Shah from Zeta Labs here (priya.shah@zetalabs.io, +91 98765 43210). Mr Shah agrees.";
    const out = redactLeaks(text, terms);
    expect(out).toBe("Hi, [person] from [company] here ([email], [phone]). Mr [person] agrees.");
    expect(findLeaks(out, terms)).toEqual([]);
  });

  test("leaves ordinary words alone", () => {
    expect(redactLeaks("the best way", terms)).toBe("the best way");
  });
});

describe("describeLeaks", () => {
  test("says what matched; a phone only by its last 4 digits", () => {
    expect(
      describeLeaks([
        { kind: "name", value: "Priya Shah" },
        { kind: "phone", value: "76543210" },
      ]),
    ).toBe("Priya Shah (a name), …3210 (a phone number)");
  });
});
