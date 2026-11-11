import { describe, expect, test } from "bun:test";
import {
  countHashtags,
  isAlwaysAddedKnowledge,
  MAX_PICKED_KNOWLEDGE,
  MAX_POST_IMAGE_BYTES,
  MAX_POST_IMAGES,
  MAX_POST_LENGTH,
  MAX_REWRITE_INSTRUCTION_LENGTH,
  MAX_TOPIC_LENGTH,
  sortKnowledgeForPosts,
} from "./contract";
import {
  isImageId,
  isPostId,
  parseCreatePost,
  parseGenerateDrafts,
  parseGeneration,
  parseListQuery,
  parseRewriteDraft,
  parseSource,
  parseUpdatePost,
  sniffImageType,
  validateImageUpload,
} from "./requests";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0, 0, 0, 0, 0, 0]);

describe("parseListQuery", () => {
  test("defaults", () => {
    expect(parseListQuery(new URLSearchParams())).toEqual({
      ok: true,
      value: { statuses: null, linkedinAccountId: null, page: 1, pageSize: 25 },
    });
  });
  test("statuses, account and paging", () => {
    const parsed = parseListQuery(new URLSearchParams("status=draft,failed,draft&account=acc1&page=2&pageSize=10"));
    expect(parsed).toEqual({ ok: true, value: { statuses: ["draft", "failed"], linkedinAccountId: "acc1", page: 2, pageSize: 10 } });
  });
  test("refuses unknown statuses and bad paging", () => {
    expect(parseListQuery(new URLSearchParams("status=deleted")).ok).toBe(false);
    expect(parseListQuery(new URLSearchParams("page=0")).ok).toBe(false);
    expect(parseListQuery(new URLSearchParams("page=1.5")).ok).toBe(false);
    expect(parseListQuery(new URLSearchParams("pageSize=101")).ok).toBe(false);
  });
});

describe("parseCreatePost", () => {
  test("an account is required; the body may be empty", () => {
    expect(parseCreatePost({ linkedinAccountId: " acc1 " })).toEqual({ ok: true, value: { linkedinAccountId: "acc1", body: "" } });
    expect(parseCreatePost({ body: "Hi" }).ok).toBe(false);
    expect(parseCreatePost(null).ok).toBe(false);
    expect(parseCreatePost([]).ok).toBe(false);
  });
  test("normalises line breaks and holds LinkedIn's limit", () => {
    expect(parseCreatePost({ linkedinAccountId: "a", body: "one\r\ntwo\rthree" })).toEqual({
      ok: true,
      value: { linkedinAccountId: "a", body: "one\ntwo\nthree" },
    });
    expect(parseCreatePost({ linkedinAccountId: "a", body: "x".repeat(MAX_POST_LENGTH) }).ok).toBe(true);
    expect(parseCreatePost({ linkedinAccountId: "a", body: "x".repeat(MAX_POST_LENGTH + 1) }).ok).toBe(false);
    expect(parseCreatePost({ linkedinAccountId: "a", body: 42 }).ok).toBe(false);
  });
});

describe("parseUpdatePost", () => {
  test("takes either field, refuses nothing to change", () => {
    expect(parseUpdatePost({ body: "Hello" })).toEqual({ ok: true, value: { body: "Hello" } });
    expect(parseUpdatePost({ linkedinAccountId: "b" })).toEqual({ ok: true, value: { linkedinAccountId: "b" } });
    expect(parseUpdatePost({}).ok).toBe(false);
    expect(parseUpdatePost({ status: "published" }).ok).toBe(false);
    expect(parseUpdatePost({ linkedinAccountId: "" }).ok).toBe(false);
  });
});

describe("images", () => {
  test("sniffs the four types and nothing else", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(PDF)).toBeNull();
  });

  const upload = (over: Partial<Parameters<typeof validateImageUpload>[0]> = {}) =>
    validateImageUpload({ declaredType: "image/png", fileName: "chart.png", head: PNG, size: 1000, existingCount: 0, ...over });

  test("accepts an image whose bytes match", () => {
    expect(upload()).toEqual({ ok: true, value: { contentType: "image/png", fileName: "chart.png", bytes: 1000 } });
    expect(upload({ declaredType: "image/jpg", head: JPG }).ok).toBe(true);
    expect(upload({ declaredType: "", head: WEBP })).toMatchObject({ ok: true, value: { contentType: "image/webp" } });
  });
  test("refuses too many, too big, empty, wrong or mismatched", () => {
    expect(upload({ existingCount: MAX_POST_IMAGES }).ok).toBe(false);
    expect(upload({ size: MAX_POST_IMAGE_BYTES + 1 }).ok).toBe(false);
    expect(upload({ size: 0 }).ok).toBe(false);
    expect(upload({ declaredType: "application/pdf", head: PDF }).ok).toBe(false);
    expect(upload({ declaredType: "image/gif", head: PNG }).ok).toBe(false);
  });
  test("cleans the file name", () => {
    expect(upload({ fileName: 'a/b\\c".png' })).toMatchObject({ value: { fileName: "a_b_c_.png" } });
    expect(upload({ fileName: "" })).toMatchObject({ value: { fileName: "image.png" } });
  });
  test("image file names and post ids", () => {
    expect(isImageId("3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f")).toBe(true);
    expect(isImageId("3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f.png")).toBe(false);
    expect(isImageId("../3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f")).toBe(false);
    expect(isPostId("3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f")).toBe(true);
    expect(isPostId("abc")).toBe(false);
  });
});

const DOC_1 = "11111111-1111-4111-8111-111111111111";
const DOC_2 = "22222222-2222-4222-8222-222222222222";
const GENERATION = { model: "openai/gpt-5.2", prompts: [{ name: "linkedin/post-system", version: 3 }, { name: "linkedin/post-user", version: null }] };

describe("parseGenerateDrafts", () => {
  test("a topic, documents, or both", () => {
    expect(parseGenerateDrafts({ linkedinAccountId: "acc", topic: " Cold calls\r\nbefore 10 " })).toEqual({
      ok: true,
      value: { linkedinAccountId: "acc", topic: "Cold calls\nbefore 10", knowledgeDocumentIds: [] },
    });
    expect(parseGenerateDrafts({ linkedinAccountId: "acc", knowledgeDocumentIds: [DOC_1.toUpperCase(), DOC_1, DOC_2] })).toEqual({
      ok: true,
      value: { linkedinAccountId: "acc", topic: null, knowledgeDocumentIds: [DOC_1, DOC_2] },
    });
  });

  test("refuses nothing to write from, bad ids, and too much", () => {
    expect(parseGenerateDrafts({ linkedinAccountId: "acc", topic: "  " }).ok).toBe(false);
    expect(parseGenerateDrafts({ topic: "x" }).ok).toBe(false);
    expect(parseGenerateDrafts({ linkedinAccountId: "acc", knowledgeDocumentIds: ["not-a-uuid"] }).ok).toBe(false);
    expect(parseGenerateDrafts({ linkedinAccountId: "acc", knowledgeDocumentIds: DOC_1 }).ok).toBe(false);
    expect(parseGenerateDrafts({ linkedinAccountId: "acc", topic: "x".repeat(MAX_TOPIC_LENGTH + 1) }).ok).toBe(false);
    const many = Array.from({ length: MAX_PICKED_KNOWLEDGE + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(parseGenerateDrafts({ linkedinAccountId: "acc", knowledgeDocumentIds: many }).ok).toBe(false);
    expect(parseGenerateDrafts([]).ok).toBe(false);
  });
});

describe("parseRewriteDraft", () => {
  test("the current text and an instruction; sources optional", () => {
    expect(parseRewriteDraft({ linkedinAccountId: "acc", body: "My post", instruction: " shorter " })).toEqual({
      ok: true,
      value: { linkedinAccountId: "acc", topic: null, knowledgeDocumentIds: [], body: "My post", instruction: "shorter" },
    });
  });

  test("refuses no text, no instruction, or too much of either", () => {
    expect(parseRewriteDraft({ linkedinAccountId: "acc", body: " ", instruction: "shorter" }).ok).toBe(false);
    expect(parseRewriteDraft({ linkedinAccountId: "acc", body: "Text", instruction: "" }).ok).toBe(false);
    expect(parseRewriteDraft({ linkedinAccountId: "acc", body: "Text" }).ok).toBe(false);
    expect(parseRewriteDraft({ linkedinAccountId: "acc", body: "x".repeat(MAX_POST_LENGTH + 1), instruction: "shorter" }).ok).toBe(false);
    expect(parseRewriteDraft({ linkedinAccountId: "acc", body: "Text", instruction: "x".repeat(MAX_REWRITE_INSTRUCTION_LENGTH + 1) }).ok).toBe(false);
  });
});

describe("parseSource and parseGeneration", () => {
  test("a source as the generate route answers it", () => {
    expect(parseSource({ kind: "knowledge", topic: "x", knowledgeDocumentIds: [DOC_1] })).toEqual({ ok: true, value: { kind: "knowledge", topic: "x", knowledgeDocumentIds: [DOC_1] } });
    expect(parseSource({ kind: "topic", topic: "x" })).toEqual({ ok: true, value: { kind: "topic", topic: "x" } });
    expect(parseSource({ kind: "blank" })).toEqual({ ok: true, value: { kind: "blank" } });
  });

  test("refuses Phase 4's kind, a Knowledge source without documents, and extra fields", () => {
    expect(parseSource({ kind: "conversations", themeSummary: "x" }).ok).toBe(false);
    expect(parseSource({ kind: "knowledge" }).ok).toBe(false);
    expect(parseSource({ kind: "topic", topic: "x", messageIds: ["m1"] }).ok).toBe(false);
    expect(parseSource("topic").ok).toBe(false);
  });

  test("a generation names our prompts and their versions", () => {
    expect(parseGeneration(GENERATION)).toEqual({ ok: true, value: GENERATION });
    expect(parseGeneration(null)).toEqual({ ok: true, value: null });
    expect(parseGeneration({ ...GENERATION, prompts: [{ name: "crm/draft-system", version: 1 }] }).ok).toBe(false);
    expect(parseGeneration({ ...GENERATION, prompts: [{ name: "linkedin/post-user", version: 0 }] }).ok).toBe(false);
    expect(parseGeneration({ model: "", prompts: [] }).ok).toBe(false);
    expect(parseGeneration({ ...GENERATION, cost: 1 }).ok).toBe(false);
  });

  test("create and update carry them as the post's origin", () => {
    const source = { kind: "topic", topic: "x" };
    expect(parseCreatePost({ linkedinAccountId: "acc", body: "Hi", source, generation: GENERATION })).toEqual({
      ok: true,
      value: { linkedinAccountId: "acc", body: "Hi", origin: { source: { kind: "topic", topic: "x" }, generation: GENERATION } },
    });
    expect(parseUpdatePost({ source, generation: GENERATION })).toEqual({ ok: true, value: { origin: { source: { kind: "topic", topic: "x" }, generation: GENERATION } } });
    expect(parseCreatePost({ linkedinAccountId: "acc", body: "Hi" })).toEqual({ ok: true, value: { linkedinAccountId: "acc", body: "Hi" } });
    expect(parseUpdatePost({ generation: GENERATION }).ok).toBe(false);
    expect(parseCreatePost({ linkedinAccountId: "acc", source: { kind: "conversations" } }).ok).toBe(false);
  });
});

describe("Knowledge for posts", () => {
  test("case studies, objections and FAQs first", () => {
    const sorted = sortKnowledgeForPosts([
      { kind: "company", title: "About" },
      { kind: "faq", title: "B FAQ" },
      { kind: "case_study", title: "Z case" },
      { kind: "objection", title: "Too expensive" },
      { kind: "faq", title: "A FAQ" },
      { kind: "pricing", title: "Pricing" },
    ]);
    expect(sorted.map((d) => d.title)).toEqual(["Z case", "Too expensive", "A FAQ", "B FAQ", "About", "Pricing"]);
  });

  test("only always-include documents tagged public are added on their own", () => {
    expect(isAlwaysAddedKnowledge({ alwaysInclude: true, isPublic: true })).toBe(true);
    expect(isAlwaysAddedKnowledge({ alwaysInclude: true, isPublic: false })).toBe(false);
    expect(isAlwaysAddedKnowledge({ alwaysInclude: false, isPublic: true })).toBe(false);
  });

  test("countHashtags", () => {
    expect(countHashtags("#sales is #fun\n#B2B")).toBe(3);
    expect(countHashtags("We were #1, C# devs, a&#39;b, url.com/#anchor")).toBe(0);
  });
});
