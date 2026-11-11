import { describe, expect, test } from "bun:test";
import { MAX_POST_IMAGE_BYTES, MAX_POST_IMAGES, MAX_POST_LENGTH } from "./contract";
import {
  isImageId,
  isPostId,
  parseCreatePost,
  parseListQuery,
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
