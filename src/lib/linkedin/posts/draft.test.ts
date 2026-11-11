import { describe, expect, test } from "bun:test";
import { codeTemplates } from "@/lib/prompts/templates";
import { MAX_POST_LENGTH } from "./contract";
import {
  buildPostPrompt,
  buildRewritePrompt,
  generatePostDrafts,
  POST_DRAFT_PROMPTS,
  POST_REWRITE_PROMPTS,
  rewritePost,
  validatePostsOutput,
  type PostCompletion,
  type PostCompletionInput,
  type PostDraftDependencies,
  type PostPromptInput,
} from "./draft";

const LONG_CASE_STUDY = `Acme cut onboarding from 14 days to 3.\n${"Detail line. ".repeat(2_000)}\nThe end of the case study.`;

function input(overrides: Partial<PostPromptInput> = {}): PostPromptInput {
  return {
    author: { name: " Priya Shah ", headline: "Head of Sales at Kandid" },
    pastPosts: ["We hired our first SDR this week.\n\nHere is what I learned."],
    topic: "Why we stopped cold-calling before 10 am",
    knowledge: [{ id: "k1", title: "Acme case study", kind: "case_study", content: LONG_CASE_STUDY }],
    companyContext: [
      { id: "c1", title: "About Kandid", kind: "company", content: "Kandid builds sales tools." },
      // Picked as well as always added: sent once, as picked.
      { id: "k1", title: "Acme case study", kind: "case_study", content: LONG_CASE_STUDY },
    ],
    ...overrides,
  };
}

const posts = (...bodies: string[]) => JSON.stringify({ posts: bodies.map((body) => ({ body })) });

/** A fake model: answers in turn, running `accept` on each like the real completion, which retries a rejected one. */
function fakeCompletion(answers: string[], seen: PostCompletionInput[] = []): PostCompletion {
  return async (call) => {
    seen.push(call);
    for (const text of answers) {
      try {
        call.accept(text);
        return { text, provider: "fake", model: "fake/model-1" };
      } catch {
        /* the real completion retries */
      }
    }
    throw new Error("every attempt was rejected");
  };
}

const resolveCode: PostDraftDependencies["resolve"] = async (names) => ({
  templates: codeTemplates(names),
  prompts: names.map((name, index) => ({ name, text: "", client: null, version: index === 0 ? 7 : null })),
});

describe("buildPostPrompt", () => {
  test("carries the author, past posts, topic and Knowledge read whole", () => {
    const prompt = buildPostPrompt(input());
    const context = JSON.parse(prompt.userPrompt.slice(prompt.userPrompt.indexOf("{")));
    expect(context.author).toEqual({ name: "Priya Shah", headline: "Head of Sales at Kandid" });
    expect(context.pastPosts).toHaveLength(1);
    expect(context.topic).toBe("Why we stopped cold-calling before 10 am");
    expect(context.knowledge).toEqual([{ title: "Acme case study", kind: "case_study", content: LONG_CASE_STUDY.trim() }]);
    // No character cap: the whole document, end included.
    expect(context.knowledge[0].content.length).toBeGreaterThan(20_000);
    expect(context.knowledge[0].content.endsWith("The end of the case study.")).toBe(true);
    expect(context.companyContext).toEqual([{ title: "About Kandid", kind: "company", content: "Kandid builds sales tools." }]);
    expect(prompt.userPrompt.startsWith("Write 3 different LinkedIn posts")).toBe(true);
    expect(prompt.toolDescription).toContain("Submit the LinkedIn posts");
  });

  test("asks for three posts of at most 3,000 characters", () => {
    const prompt = buildPostPrompt(input());
    const schema = prompt.jsonSchema as { properties: { posts: { minItems: number; maxItems: number; items: { properties: { body: { maxLength: number } } } } } };
    expect(schema.properties.posts.minItems).toBe(3);
    expect(schema.properties.posts.maxItems).toBe(3);
    expect(schema.properties.posts.items.properties.body.maxLength).toBe(MAX_POST_LENGTH);
    expect(prompt.rules).toEqual({ count: 3, maxHashtags: 0 });
  });

  test("without past posts, the prompt says so and asks for a plain voice", () => {
    const prompt = buildPostPrompt(input({ pastPosts: [] }));
    expect(prompt.systemPrompt).toContain("There are no past posts by the author");
    expect(prompt.systemPrompt).not.toContain("Match how they write");
    expect(prompt.snapshot.pastPosts).toEqual([]);
  });

  test("hashtags are allowed (at most 3) only when the past posts use them", () => {
    expect(buildPostPrompt(input()).systemPrompt).toContain("Use no hashtags");
    const tagged = buildPostPrompt(input({ pastPosts: ["Shipped it. #sales #startups"] }));
    expect(tagged.systemPrompt).toContain("at most 3 relevant ones");
    expect(tagged.rules.maxHashtags).toBe(3);
  });

  test("works from Knowledge alone, or a topic alone, but not from nothing", () => {
    expect(buildPostPrompt(input({ topic: null })).userPrompt).toContain("There is no topic");
    expect(buildPostPrompt(input({ knowledge: [] })).snapshot.knowledge).toBeUndefined();
    expect(() => buildPostPrompt(input({ topic: "  ", knowledge: [] }))).toThrow(/topic, a theme or a Knowledge document/);
  });

  test("uses the templates it is given (Langfuse's versions)", () => {
    const templates = { ...codeTemplates([...POST_DRAFT_PROMPTS, ...POST_REWRITE_PROMPTS]), "linkedin/post-user": "Make {{variants}}. {{context_json}}" };
    expect(buildPostPrompt(input(), templates).userPrompt.startsWith("Make 3. {")).toBe(true);
  });
});

describe("buildRewritePrompt", () => {
  test("carries the current post and the instruction, and asks for one post", () => {
    const prompt = buildRewritePrompt({ ...input(), currentPost: "My long post.\r\nSecond line.", instruction: " shorter " });
    expect(prompt.snapshot.currentPost).toBe("My long post.\nSecond line.");
    expect(prompt.snapshot.instruction).toBe("shorter");
    expect(prompt.userPrompt).toContain("Rewrite the author's current LinkedIn post");
    expect(prompt.rules).toEqual({ count: 1, maxHashtags: 0, differentFrom: "My long post.\nSecond line." });
  });

  test("keeps hashtags the rep wrote", () => {
    const prompt = buildRewritePrompt({ ...input(), currentPost: "Post #a #b #c #d #e", instruction: "shorter" });
    expect(prompt.rules.maxHashtags).toBe(5);
  });

  test("needs text and an instruction", () => {
    expect(() => buildRewritePrompt({ ...input(), currentPost: " ", instruction: "shorter" })).toThrow(/no text/);
    expect(() => buildRewritePrompt({ ...input(), currentPost: "Text", instruction: "" })).toThrow(/how to rewrite/);
  });
});

describe("validatePostsOutput", () => {
  const rules = { count: 3, maxHashtags: 0 };

  test("accepts three different posts, trimmed", () => {
    expect(validatePostsOutput(posts(" One ", "Two\r\nlines", "Three"), rules)).toEqual([{ body: "One" }, { body: "Two\nlines" }, { body: "Three" }]);
  });

  test("rejects answers off the schema", () => {
    expect(() => validatePostsOutput("not json", rules)).toThrow(/malformed JSON/);
    expect(() => validatePostsOutput(posts("One", "Two"), rules)).toThrow(/2 posts, not 3/);
    expect(() => validatePostsOutput(JSON.stringify({ posts: [], extra: 1 }), rules)).toThrow(/unknown field/);
    expect(() => validatePostsOutput(JSON.stringify({ posts: [{ body: "a", title: "x" }, { body: "b" }, { body: "c" }] }), rules)).toThrow(/Post 1 has unknown field/);
    expect(() => validatePostsOutput(posts("One", " ", "Three"), rules)).toThrow(/Post 2 is empty/);
    expect(() => validatePostsOutput(posts("One", "Two", "x".repeat(MAX_POST_LENGTH + 1)), rules)).toThrow(/Post 3 is 3001 characters/);
    expect(() => validatePostsOutput(posts("Same", "Same", "Other"), rules)).toThrow(/same post twice/);
  });

  test("holds the hashtag rule", () => {
    expect(() => validatePostsOutput(posts("One #sales", "Two", "Three"), rules)).toThrow(/uses hashtags; the author does not/);
    expect(() => validatePostsOutput(posts("One #a #b #c #d", "Two", "Three"), { count: 3, maxHashtags: 3 })).toThrow(/4 hashtags; at most 3/);
    // Not a hashtag: a number, an anchor-like fragment inside a word.
    expect(validatePostsOutput(posts("We were #1 in Q3", "C# developers", "Three"), rules)).toHaveLength(3);
  });

  test("a rewrite must differ from the current post", () => {
    expect(() => validatePostsOutput(posts("Current"), { count: 1, maxHashtags: 0, differentFrom: "Current" })).toThrow(/same as the current post/);
  });
});

describe("generatePostDrafts", () => {
  test("retries an off-schema answer, returns the drafts and records the generation", async () => {
    const seen: PostCompletionInput[] = [];
    const result = await generatePostDrafts(input(), {
      resolve: resolveCode,
      complete: fakeCompletion([posts("Only one"), posts("A", "B", "C")], seen),
    });
    expect(result.variants).toEqual([{ body: "A" }, { body: "B" }, { body: "C" }]);
    expect(result.generation).toEqual({
      model: "fake/model-1",
      prompts: [
        { name: "linkedin/post-system", version: 7 },
        { name: "linkedin/post-user", version: null },
        { name: "linkedin/post-tool", version: null },
      ],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].trace.name).toBe("linkedin-post-draft");
    expect(seen[0].trace.metadata).toMatchObject({ variants: 3, pastPosts: 1 });
    // The trace's metadata carries counts, never the text.
    expect(JSON.stringify(seen[0].trace.metadata)).not.toContain("Acme");
    expect(seen[0].toolDescription).toContain("Submit the LinkedIn posts");
  });

  test("fails when every attempt is off-schema", async () => {
    await expect(generatePostDrafts(input(), { resolve: resolveCode, complete: fakeCompletion([posts("One"), "{}"]) })).rejects.toThrow(/rejected/);
  });

  test("uses the copies in code when no organization is in scope", async () => {
    const seen: PostCompletionInput[] = [];
    const result = await generatePostDrafts(input(), { complete: fakeCompletion([posts("A", "B", "C")], seen) });
    expect(result.generation.prompts.map((prompt) => prompt.version)).toEqual([null, null, null]);
    expect(seen[0].systemPrompt).toContain("You write LinkedIn posts for one person");
  });
});

describe("rewritePost", () => {
  test("returns one variant, traced as a rewrite", async () => {
    const seen: PostCompletionInput[] = [];
    const result = await rewritePost(
      { ...input(), currentPost: "The long version.", instruction: "shorter" },
      { resolve: resolveCode, complete: fakeCompletion([posts("The long version."), posts("Short.")], seen) },
    );
    expect(result.variants).toEqual([{ body: "Short." }]);
    expect(seen[0].trace.name).toBe("linkedin-post-rewrite");
    expect(result.generation.prompts.map((prompt) => prompt.name)).toEqual([...POST_REWRITE_PROMPTS]);
  });
});
