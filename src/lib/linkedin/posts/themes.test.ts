import { describe, expect, test } from "bun:test";
import { codeTemplates } from "@/lib/prompts/templates";
import { runInOrganization } from "@/lib/tenancy/scope";
import { conversationsLeakMessage } from "./leakCheck.server";
import { leakTerms } from "./leakGuard";
import { buildPostPrompt, type PostCompletion, type PostCompletionInput } from "./draft";
import { sealTheme, themeSealValid } from "./themeSeal.server";
import { buildThemesPrompt, clipItem, leadSideOfCall, MAX_THEME_ITEM_CHARS, replyText, themeRange, validateThemesOutput } from "./themes";
import { findPostThemes, type ThemeDependencies, type ThemeSourceSet } from "./themes.server";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const SECRET = "test-secret-for-theme-seals";
process.env.INTEGRATION_CREDENTIALS_KEY ??= SECRET;

describe("replyText", () => {
  test("keeps the reply, cuts quoted history", () => {
    const body = "Sounds good, but setup worries me.\n\nOn Tue, 10 Nov 2026 at 09:00, Sam <sam@us.com> wrote:\n> Hi Priya, here is our pitch";
    expect(replyText(body)).toBe("Sounds good, but setup worries me.");
    expect(replyText("Too pricey.\n> earlier\n-----Original Message-----\nFrom: us")).toBe("Too pricey.");
    expect(replyText("Busy this week.\r\nFrom: Sam\r\nSent: Monday")).toBe("Busy this week.");
    expect(replyText("> only quoted")).toBe("");
  });

  test("the lead's side of a call", () => {
    expect(leadSideOfCall([
      { speaker: "rep", text: "Hi" },
      { speaker: "lead", text: " We tried this before. " },
      { speaker: "lead", text: "" },
      { speaker: "lead", text: "It took months." },
    ])).toBe("We tried this before.\nIt took months.");
  });

  test("clips a long item", () => {
    expect(clipItem("x".repeat(MAX_THEME_ITEM_CHARS + 50)).length).toBe(MAX_THEME_ITEM_CHARS + 1);
    expect(clipItem("short")).toBe("short");
  });
});

describe("the themes prompt", () => {
  test("3–6 themes from enough messages, fewer from few", () => {
    expect(themeRange(50)).toEqual({ min: 3, max: 6 });
    expect(themeRange(6)).toEqual({ min: 3, max: 6 });
    expect(themeRange(4)).toEqual({ min: 1, max: 3 });
    expect(themeRange(1)).toEqual({ min: 1, max: 1 });
  });

  test("carries the items and the range, and the privacy rule", () => {
    const prompt = buildThemesPrompt([
      { channel: "email", at: "2026-11-10T00:00:00.000Z", text: "[person] says it is too pricey" },
      { channel: "call", at: "2026-11-09T00:00:00.000Z", text: "We tried this before" },
    ]);
    expect(prompt.systemPrompt).toContain("into 1 to 2 themes");
    expect(prompt.systemPrompt).toContain("must not identify anyone");
    expect(prompt.userPrompt).toContain("these 2 messages");
    expect(prompt.userPrompt).toContain("too pricey");
    expect(prompt.rules).toEqual({ min: 1, max: 2, items: 2 });
    expect(() => buildThemesPrompt([])).toThrow();
  });
});

const theme = (title: string, mentions = 2, summary = `Prospects keep saying ${title.toLowerCase()}.`) => ({ title, kind: "objection", summary, mentions });

describe("validateThemesOutput", () => {
  const rules = { min: 1, max: 3, items: 5 };
  test("accepts themes in range, most raised first", () => {
    const out = validateThemesOutput(JSON.stringify({ themes: [theme("Price", 1), theme("Setup time", 4)] }), rules);
    expect(out.map((item) => item.title)).toEqual(["Setup time", "Price"]);
  });

  test("refuses off-schema answers", () => {
    expect(() => validateThemesOutput("not json", rules)).toThrow();
    expect(() => validateThemesOutput({ themes: [] }, rules)).toThrow();
    expect(() => validateThemesOutput({ themes: [theme("A"), theme("B"), theme("C"), theme("D")] }, rules)).toThrow();
    expect(() => validateThemesOutput({ themes: [{ ...theme("A"), kind: "rant" }] }, rules)).toThrow();
    expect(() => validateThemesOutput({ themes: [theme("A", 9)] }, rules)).toThrow("only 5 messages");
    expect(() => validateThemesOutput({ themes: [theme("A"), theme("a")] }, rules)).toThrow("same title");
    expect(() => validateThemesOutput({ themes: [{ ...theme("A"), quote: "x" }] }, rules)).toThrow();
  });
});

describe("theme seals", () => {
  const fields = { organizationId: ORG, readAt: "2026-11-12T10:00:00.000Z", title: "Setup", summary: "It takes long." };
  test("hold for the same theme only", () => {
    const seal = sealTheme(fields, SECRET);
    expect(themeSealValid(fields, seal, SECRET)).toBe(true);
    expect(themeSealValid({ ...fields, organizationId: OTHER_ORG }, seal, SECRET)).toBe(false);
    expect(themeSealValid({ ...fields, readAt: "2026-10-01T00:00:00.000Z" }, seal, SECRET)).toBe(false);
    expect(themeSealValid({ ...fields, summary: "Edited." }, seal, SECRET)).toBe(false);
    expect(themeSealValid(fields, seal, "another-secret")).toBe(false);
    expect(themeSealValid(fields, "x", SECRET)).toBe(false);
  });
});

describe("findPostThemes", () => {
  const source: ThemeSourceSet = {
    items: [
      { personId: "p1", channel: "email", at: "2026-11-11T09:00:00.000Z", text: "Hi, Priya Shah from Zeta Labs. Setup took us months last time. Call +91 98765 43210." },
      { personId: "p2", channel: "linkedin", at: "2026-11-10T09:00:00.000Z", text: "Price is the issue for us." },
      { personId: "p2", channel: "whatsapp", at: "2026-11-09T09:00:00.000Z", text: "   " },
    ],
    people: [
      { firstName: "Priya", lastName: "Shah", fullName: "Priya Shah", phone: "+919876543210", companyName: "Zeta Labs" },
      { firstName: "Omar", lastName: "Haddad", companyName: "Northwind" },
    ],
  };

  function fake(answer: unknown, seen: PostCompletionInput[]): PostCompletion {
    return async (call) => {
      seen.push(call);
      const text = JSON.stringify(answer);
      call.accept(text);
      return { text, provider: "fake", model: "fake/model" };
    };
  }

  const dependencies = (answer: unknown, seen: PostCompletionInput[]): ThemeDependencies => ({
    readSource: async () => source,
    complete: fake(answer, seen),
    resolve: async (names) => ({ templates: codeTemplates(names), prompts: names.map((name) => ({ name, text: "", client: null, version: null })) }),
    now: () => new Date("2026-11-12T10:00:00.400Z"),
  });

  test("redacts what the model sees, drops a theme that names someone, seals the rest", async () => {
    const seen: PostCompletionInput[] = [];
    const answer = {
      themes: [
        theme("Setup time", 2),
        { title: "Zeta Labs wants help", kind: "question", summary: "Northwind and others ask.", mentions: 1 },
      ],
    };
    const result = await runInOrganization(ORG, () => findPostThemes(dependencies(answer, seen)));
    // The model saw placeholders, not the person.
    expect(seen[0]!.userPrompt).not.toContain("Priya");
    expect(seen[0]!.userPrompt).not.toContain("Zeta Labs");
    expect(seen[0]!.userPrompt).not.toContain("98765");
    expect(seen[0]!.userPrompt).toContain("[person] from [company]");
    // A message with nothing of its own (quoted history only, cut on reading) is left out.
    expect(result.read).toBe(2);
    expect(result.withheld).toBe(1);
    expect(result.themes.map((item) => item.title)).toEqual(["Setup time"]);
    const [kept] = result.themes;
    expect(kept!.readAt).toBe("2026-11-12T10:00:00.000Z");
    expect(themeSealValid({ organizationId: ORG, readAt: kept!.readAt, title: kept!.title, summary: kept!.summary }, kept!.seal)).toBe(true);
    // Another organization cannot use it.
    expect(themeSealValid({ organizationId: OTHER_ORG, readAt: kept!.readAt, title: kept!.title, summary: kept!.summary }, kept!.seal)).toBe(false);
  });

  test("no messages: no model call", async () => {
    const seen: PostCompletionInput[] = [];
    const result = await runInOrganization(ORG, () =>
      findPostThemes({ ...dependencies({ themes: [] }, seen), readSource: async () => ({ items: [], people: [] }) }),
    );
    expect(result).toEqual({ themes: [], read: 0, withheld: 0 });
    expect(seen).toHaveLength(0);
  });
});

describe("a draft from a theme", () => {
  test("is written from the summary only, with the theme rules", () => {
    const prompt = buildPostPrompt({
      author: { name: "Sam", headline: null },
      pastPosts: [],
      topic: null,
      knowledge: [],
      companyContext: [],
      theme: { title: "Setup time", summary: "Prospects worry setup takes months." },
    });
    expect(prompt.snapshot.theme).toEqual({ title: "Setup time", summary: "Prospects worry setup takes months." });
    expect(prompt.systemPrompt).toContain("Never quote it");
    expect(prompt.userPrompt).toContain("theme is what prospects keep raising");
    expect(prompt.userPrompt).not.toContain("There is no topic");
  });

  test("a draft with neither topic, theme nor Knowledge is refused", () => {
    expect(() => buildPostPrompt({ author: { name: "Sam", headline: null }, pastPosts: [], topic: null, knowledge: [], companyContext: [] })).toThrow();
  });
});

describe("the leak guard on a saved post", () => {
  const terms = async () => leakTerms([{ firstName: "Priya", lastName: "Shah", companyName: "Zeta Labs" }]);
  const source = { kind: "conversations" as const, themeTitle: "Setup", themeSummary: "Slow setup.", themesReadAt: "2026-11-12T10:00:00.000Z", seal: "s" };
  const createdAt = new Date("2026-11-12T11:00:00.000Z");

  test("blocks a post from a theme that names someone, and says what", async () => {
    const message = await conversationsLeakMessage({ source, body: "Zeta Labs told me setup is slow", createdAt }, undefined, terms);
    expect(message).toContain("Zeta Labs (a company)");
  });

  test("passes a clean post, and posts from any other source unchecked", async () => {
    expect(await conversationsLeakMessage({ source, body: "Setup is slow for most teams", createdAt }, undefined, terms)).toBeNull();
    expect(await conversationsLeakMessage({ source: { kind: "topic", topic: "x" }, body: "Priya Shah", createdAt }, undefined, terms)).toBeNull();
    expect(await conversationsLeakMessage({ source: null, body: "Priya Shah", createdAt }, undefined, terms)).toBeNull();
  });

  test("checks the 30 days before the theme was read", async () => {
    let asked: Date | null = null;
    await conversationsLeakMessage({ source, body: "x", createdAt }, undefined, async (readAt) => ((asked = readAt), []));
    expect(asked!.toISOString()).toBe("2026-11-12T10:00:00.000Z");
  });
});
