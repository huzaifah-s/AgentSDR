import { describe, expect, test } from "bun:test";
import { LINKEDIN_PROMPTS } from "./linkedin";
import { PROMPTS } from "./registry";
import { fillPrompt, promptVariableNames } from "./template";

const fill = (name: keyof typeof LINKEDIN_PROMPTS, variables: Parameters<typeof fillPrompt>[1]) => fillPrompt(LINKEDIN_PROMPTS[name].template, variables);

describe("LinkedIn post prompts", () => {
  test("are in the registry", () => {
    for (const name of Object.keys(LINKEDIN_PROMPTS)) expect(name in PROMPTS).toBe(true);
  });

  test("each uses only the variables the code passes", () => {
    const passed: Record<keyof typeof LINKEDIN_PROMPTS, string[]> = {
      "linkedin/post-system": ["hashtags", "max_length", "past_posts", "theme"],
      "linkedin/post-user": ["context_json", "theme", "topic", "variants"],
      "linkedin/post-rewrite": ["context_json"],
      "linkedin/post-tool": [],
      "linkedin/post-themes": ["max_themes", "min_themes"],
      "linkedin/post-themes-user": ["count", "messages_json"],
      "linkedin/post-themes-tool": [],
    };
    for (const [name, definition] of Object.entries(LINKEDIN_PROMPTS)) {
      expect(promptVariableNames(definition.template)).toEqual(passed[name as keyof typeof LINKEDIN_PROMPTS].sort());
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  test("the system prompt holds the general rules", () => {
    const system = fill("linkedin/post-system", { past_posts: true, hashtags: false, max_length: "3,000" });
    expect(system).toContain("in the first person");
    expect(system).toContain("Never state a fact, result, number, client, customer, quote or event that the context does not contain");
    expect(system).toContain("No engagement bait");
    expect(system).toContain("A post is at most 3,000 characters.");
    expect(system).not.toContain("{{");
  });

  test("the voice part follows whether there are past posts", () => {
    const withPosts = fill("linkedin/post-system", { past_posts: true });
    const without = fill("linkedin/post-system", { past_posts: false });
    expect(withPosts).toContain("Match how they write");
    expect(withPosts).not.toContain("no past posts");
    expect(without).toContain("There are no past posts by the author");
    expect(without).toContain("plain, direct, first-person voice");
    expect(without).not.toContain("Match how they write");
  });

  test("hashtags: at most 3 when the author uses them, otherwise none", () => {
    expect(fill("linkedin/post-system", { hashtags: true })).toContain("at most 3 relevant ones");
    const none = fill("linkedin/post-system", { hashtags: false });
    expect(none).toContain("Use no hashtags");
    expect(none).not.toContain("at most 3");
  });

  test("the user message asks for the variants, on the topic when there is one", () => {
    const withTopic = fill("linkedin/post-user", { variants: 3, topic: true, context_json: '{"a":1}' });
    expect(withTopic.startsWith("Write 3 different LinkedIn posts")).toBe(true);
    expect(withTopic).toContain("keep every post on it");
    expect(withTopic.endsWith('\n\n{"a":1}')).toBe(true);
    expect(fill("linkedin/post-user", { variants: 3, topic: false, context_json: "{}" })).toContain("There is no topic");
  });

  test("the rewrite message", () => {
    const rewrite = fill("linkedin/post-rewrite", { context_json: "{}" });
    expect(rewrite).toContain("currentPost");
    expect(rewrite).toContain("Return one post, different from the current one.");
  });
});
