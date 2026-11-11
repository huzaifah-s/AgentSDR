import { describe, expect, test } from "bun:test";
import { renderAiInstructions } from "@/lib/crm/ai/instructions";
import { hasPublicTag, voiceLine, withPublicTag, type PostTheme } from "./contract";
import { buildPostPrompt, buildRewritePrompt, type PostPromptInput } from "./draft";
import { buildIdeasPrompt, ideaSource, ideaTopic, toIdeas, validateIdeasOutput } from "./ideas";
import { DEFAULT_POST_INSTRUCTIONS, NEVER_POST_BLOCK_ID, VOICE_BLOCK_HINTS } from "./postInstructions";
import { parseAuthorVoice, parsePostIdeas } from "./requests";
import { voiceSummaryBlocks } from "./voices.server";

function input(overrides: Partial<PostPromptInput> = {}): PostPromptInput {
  return {
    author: { name: "Sam Rivera", headline: "Founder" },
    pastPosts: [],
    topic: "Why we stopped cold-calling",
    knowledge: [],
    companyContext: [],
    ...overrides,
  };
}

describe("the content brief's defaults", () => {
  test("hold the five blocks the plan names, never-post among them", () => {
    expect(DEFAULT_POST_INSTRUCTIONS.map((block) => block.title)).toEqual([
      "Who we're talking to",
      "What we post about",
      "How we sound",
      "What we never post",
      "Our call to action",
    ]);
    const never = DEFAULT_POST_INSTRUCTIONS.find((block) => block.id === NEVER_POST_BLOCK_ID)!;
    expect(never.content).toContain("Prices");
    expect(never.content).toContain("Competitors by name");
    expect(new Set(DEFAULT_POST_INSTRUCTIONS.map((block) => block.id)).size).toBe(DEFAULT_POST_INSTRUCTIONS.length);
    for (const block of DEFAULT_POST_INSTRUCTIONS) expect(block.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("the layers in the post prompt", () => {
  const brief = renderAiInstructions(DEFAULT_POST_INSTRUCTIONS)!;

  test("brief → voice → this post's notes, never-post always winning", () => {
    const prompt = buildPostPrompt(input({ brief, voice: { instructions: "## How I sound\n- Short sentences.", examplePosts: [] } }));
    const system = prompt.systemPrompt;
    const at = (text: string) => system.indexOf(text);
    expect(at("content brief")).toBeGreaterThan(-1);
    expect(at("What we never post")).toBeGreaterThan(at("content brief"));
    expect(at("The author's own writing voice")).toBeGreaterThan(at("What we never post"));
    expect(at("- Short sentences.")).toBeGreaterThan(at("The author's own writing voice"));
    expect(system).toContain("anything the brief says never to post always wins");
    expect(system).toContain("The author's voice decides tone and format over the brief's tone");
    expect(system).toContain("win over the author's defaults for this post");
    // The brief is about how to write, never a source of facts.
    expect(system).toContain("facts still come only from the context");
    expect(system).not.toContain("{{");
  });

  test("without a brief or a voice, none of it is there", () => {
    const system = buildPostPrompt(input()).systemPrompt;
    expect(system).not.toContain("content brief");
    expect(system).not.toContain("own writing voice");
    expect(system).not.toContain("Where these disagree");
  });

  test("example posts go in the context; their hashtags allow hashtags", () => {
    const prompt = buildPostPrompt(input({ voice: { instructions: null, examplePosts: ["Shipping beats planning. #startups", "  "] } }));
    expect(prompt.snapshot.voiceExamples).toEqual(["Shipping beats planning. #startups"]);
    expect(prompt.systemPrompt).toContain("voiceExamples in the context");
    expect(prompt.rules.maxHashtags).toBe(3);
    expect(buildPostPrompt(input()).rules.maxHashtags).toBe(0);
  });

  test("a rewrite carries the same layers", () => {
    const prompt = buildRewritePrompt({ ...input({ brief }), currentPost: "Old text", instruction: "make this one formal" });
    expect(prompt.systemPrompt).toContain("What we never post");
    expect(prompt.userPrompt).toContain("make this one formal");
  });
});

describe("parseAuthorVoice", () => {
  test("keeps written blocks, drops empty ones, trims example posts", () => {
    const parsed = parseAuthorVoice({
      instructions: [
        { id: "sound", title: "How I sound", content: "  Casual. " },
        { id: "format", title: "Format", content: "   " },
      ],
      examplePosts: ["  First  ", "", "Second"],
    });
    expect(parsed).toEqual({ ok: true, value: { instructions: [{ id: "sound", title: "How I sound", content: "Casual." }], examplePosts: ["First", "Second"] } });
    expect(parseAuthorVoice({ instructions: [{ id: "a", title: "x", content: " " }], examplePosts: [] })).toEqual({ ok: true, value: { instructions: null, examplePosts: [] } });
    expect(parseAuthorVoice({ instructions: null })).toEqual({ ok: true, value: { instructions: null, examplePosts: [] } });
  });

  test("refuses too many or too long examples, bad blocks and unknown fields", () => {
    expect(parseAuthorVoice({ examplePosts: ["a", "b", "c", "d", "e", "f"] }).ok).toBe(false);
    expect(parseAuthorVoice({ examplePosts: ["x".repeat(3001)] }).ok).toBe(false);
    expect(parseAuthorVoice({ instructions: [{ id: "a b", title: "x", content: "y" }] }).ok).toBe(false);
    expect(parseAuthorVoice({ instructions: [{ id: "a", title: "x", content: "y" }, { id: "a", title: "z", content: "w" }] }).ok).toBe(false);
    expect(parseAuthorVoice({ instructions: [{ id: "a", title: "x", content: "y", extra: 1 }] }).ok).toBe(false);
    expect(parseAuthorVoice({ owner: "someone" }).ok).toBe(false);
    expect(parseAuthorVoice("voice").ok).toBe(false);
  });
});

describe("voiceLine", () => {
  test("the first written block, clipped, and how many examples", () => {
    expect(voiceLine({ instructions: [{ title: "How I sound", content: "Casual,\nshort." }], examplePosts: ["a"] })).toBe("Casual, short. · 1 example post");
    expect(voiceLine({ instructions: [], examplePosts: ["a", "b"] })).toBe("2 example posts");
    expect(voiceLine({ instructions: [{ title: "x", content: "y".repeat(200) }], examplePosts: [] })!.length).toBe(118);
    expect(voiceLine({ instructions: [], examplePosts: [] })).toBeNull();
    expect(voiceLine(null)).toBeNull();
  });
});

describe("the public switch", () => {
  test("sets or takes off the public tag, leaving the others", () => {
    expect(withPublicTag(["pricing", "onboarding"], true)).toEqual(["pricing", "onboarding", "public"]);
    expect(withPublicTag(["Public", "onboarding"], false)).toEqual(["onboarding"]);
    expect(withPublicTag(["public"], true)).toEqual(["public"]);
    expect(hasPublicTag(["PUBLIC "])).toBe(true);
    expect(hasPublicTag(["publicity"])).toBe(false);
  });
});

describe("voiceSummaryBlocks", () => {
  test("titles the fields as the dialog's hints and leaves empty ones out", () => {
    const blocks = voiceSummaryBlocks(JSON.stringify({ sound: "- I keep it short.", format: "", language: "- English, UK spelling.", phrases: "", topics: "" }));
    expect(blocks).toEqual([
      { id: "sound", title: VOICE_BLOCK_HINTS[0]!.title, content: "- I keep it short." },
      { id: "language", title: "Language", content: "- English, UK spelling." },
    ]);
  });

  test("refuses an empty or off-schema answer", () => {
    expect(() => voiceSummaryBlocks({ sound: "", format: "", language: "", phrases: "", topics: "" })).toThrow();
    expect(() => voiceSummaryBlocks({ sound: "x", mood: "y" })).toThrow();
    expect(() => voiceSummaryBlocks("nope")).toThrow();
  });
});

const THEME: PostTheme = { title: "Setup time", kind: "objection", summary: "Setup takes too long.", mentions: 3, readAt: "2026-11-12T10:00:00.000Z", seal: "sealsealsealsealsealseal" };
const IDEA_INPUT = {
  brief: "## What we post about\n- Onboarding",
  knowledge: [{ id: "doc-1", title: "Case study", kind: "case_study", content: "Acme cut onboarding to 3 days." }],
  themes: [THEME],
};

describe("post ideas", () => {
  test("the prompt: brief in the system prompt, sources by ref in the JSON", () => {
    const prompt = buildIdeasPrompt(IDEA_INPUT);
    expect(prompt.systemPrompt).toContain("Suggest exactly 5 different ideas");
    expect(prompt.systemPrompt).toContain("## What we post about");
    const context = JSON.parse(prompt.userPrompt);
    expect(context.knowledge[0]).toMatchObject({ ref: "K1", title: "Case study" });
    expect(context.themes[0]).toEqual({ ref: "T1", title: "Setup time", kind: "objection", summary: "Setup takes too long.", mentions: 3 });
    // The seal and read time stay on the server's side.
    expect(prompt.userPrompt).not.toContain("seal");
    expect(prompt.refs).toEqual({ knowledge: ["K1"], themes: ["T1"] });
  });

  const idea = (title: string, basedOn: string[] = []) => ({ title, angle: `Why ${title.toLowerCase()} matters.`, pillar: "Onboarding", basedOn });

  test("exactly 5 ideas, naming only refs that were given", () => {
    const refs = { knowledge: ["K1"], themes: ["T1"] };
    const five = [idea("A", ["K1"]), idea("B", ["T1"]), idea("C"), idea("D"), idea("E", ["K1", "T1"])];
    expect(validateIdeasOutput(JSON.stringify({ ideas: five }), refs)).toHaveLength(5);
    expect(() => validateIdeasOutput({ ideas: five.slice(0, 4) }, refs)).toThrow();
    expect(() => validateIdeasOutput({ ideas: [...five.slice(0, 4), idea("E", ["K9"])] }, refs)).toThrow("K9");
    expect(() => validateIdeasOutput({ ideas: [...five.slice(0, 4), idea("a")] }, refs)).toThrow("same title");
  });

  test("each idea opens as a draft with its source: a theme's seal, its Knowledge, or its topic", () => {
    const [fromKnowledge, fromTheme, fromBrief, , both] = toIdeas(
      [idea("A", ["K1"]), idea("B", ["T1"]), idea("C"), idea("D"), idea("E", ["K1", "T1"])],
      IDEA_INPUT,
    );
    expect(fromKnowledge!.source).toEqual({ kind: "knowledge", topic: "A: Why a matters.", knowledgeDocumentIds: ["doc-1"] });
    expect(fromTheme!.source).toMatchObject({ kind: "conversations", themeTitle: "Setup time", themeSummary: "Setup takes too long.", themesReadAt: THEME.readAt, seal: THEME.seal });
    expect(fromBrief!.source).toEqual({ kind: "topic", topic: "C: Why c matters." });
    expect(both!.source).toMatchObject({ kind: "conversations", knowledgeDocumentIds: ["doc-1"] });
    expect(ideaSource(idea("Z", ["K2"]), IDEA_INPUT)).toEqual({ kind: "topic", topic: "Z: Why z matters." });
  });

  test("the topic fits the topic limit", () => {
    expect(ideaTopic({ title: "T", angle: "x".repeat(900) }).length).toBe(500);
  });

  test("parsePostIdeas: themes on unless turned off", () => {
    expect(parsePostIdeas({})).toEqual({ ok: true, value: { includeThemes: true } });
    expect(parsePostIdeas(undefined)).toEqual({ ok: true, value: { includeThemes: true } });
    expect(parsePostIdeas({ includeThemes: false })).toEqual({ ok: true, value: { includeThemes: false } });
    expect(parsePostIdeas({ includeThemes: "no" }).ok).toBe(false);
    expect(parsePostIdeas({ count: 9 }).ok).toBe(false);
  });
});
