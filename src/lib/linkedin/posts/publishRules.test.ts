import { describe, expect, test } from "bun:test";
import { feedPreview, firstLine, MAX_POST_LENGTH, UNCERTAIN_PUBLISH_ERROR } from "./contract";
import { failureError, isStalePublishing, onlyWaits, postUrlFor, publishRefusal, STALE_PUBLISHING_MS } from "./publishRules";

const base = {
  status: "draft" as const,
  body: "Hello LinkedIn",
  attachmentCount: 0,
  account: { status: "CONNECTED" as const, name: "Ada" },
  publishedToday: 0,
  postsPerDay: 2,
};

describe("publishRefusal", () => {
  test("a draft or scheduled post with text, a connected account and room today may go", () => {
    expect(publishRefusal(base)).toBeNull();
    expect(publishRefusal({ ...base, status: "scheduled" })).toBeNull();
    expect(publishRefusal({ ...base, publishedToday: 1 })).toBeNull();
  });
  test("never claims a post twice", () => {
    expect(publishRefusal({ ...base, status: "published" })).toMatchObject({ status: 409 });
    expect(publishRefusal({ ...base, status: "publishing" })).toMatchObject({ status: 409 });
    expect(publishRefusal({ ...base, status: "failed" })).toMatchObject({ status: 409 });
  });
  test("text is required and within LinkedIn's limit", () => {
    expect(publishRefusal({ ...base, body: "  \n " })).toMatchObject({ status: 400 });
    expect(publishRefusal({ ...base, body: "x".repeat(MAX_POST_LENGTH + 1) })).toMatchObject({ status: 400 });
    expect(publishRefusal({ ...base, attachmentCount: 5 })).toMatchObject({ status: 400 });
  });
  test("the account must be the organization's and connected", () => {
    expect(publishRefusal({ ...base, account: null })).toMatchObject({ status: 409 });
    expect(publishRefusal({ ...base, account: { status: "DISCONNECTED", name: "Ada" } })?.message).toContain("Ada");
  });
  test("the daily limit holds", () => {
    const refusal = publishRefusal({ ...base, publishedToday: 2 });
    expect(refusal).toMatchObject({ status: 429 });
    expect(refusal?.message).toContain("2 posts");
    expect(publishRefusal({ ...base, publishedToday: 1, postsPerDay: 1 })?.message).toContain("1 post today");
  });
});

describe("onlyWaits", () => {
  const connected = { status: "CONNECTED" as const, name: "Alex" };
  test("the daily limit and a disconnected account only wait, so the leak guard is told first", () => {
    expect(onlyWaits(publishRefusal({ ...base, account: connected, publishedToday: 2, postsPerDay: 2 }))).toBe(true);
    expect(onlyWaits(publishRefusal({ ...base, account: { status: "DISCONNECTED", name: "Alex" } }))).toBe(true);
    expect(onlyWaits(publishRefusal({ ...base, account: null }))).toBe(true);
  });
  test("a refusal about the post itself comes before the guard", () => {
    expect(onlyWaits(publishRefusal({ ...base, status: "published" }))).toBe(false);
    expect(onlyWaits(publishRefusal({ ...base, body: " " }))).toBe(false);
    expect(onlyWaits(null)).toBe(false);
  });
});

describe("failures", () => {
  test("an uncertain one says to check LinkedIn", () => {
    expect(failureError("uncertain", "Unipile did not answer in time")).toStartWith(UNCERTAIN_PUBLISH_ERROR);
    expect(failureError("uncertain", "")).toBe(UNCERTAIN_PUBLISH_ERROR);
  });
  test("a refusal says why", () => {
    expect(failureError("refused", "Invalid account")).toBe("LinkedIn refused the post: Invalid account");
  });
  test("a post stuck publishing for over five minutes is stale", () => {
    const now = new Date("2026-11-11T10:00:00Z");
    const at = (ms: number) => new Date(now.getTime() - ms);
    expect(isStalePublishing("publishing", at(STALE_PUBLISHING_MS + 1), now)).toBe(true);
    expect(isStalePublishing("publishing", at(STALE_PUBLISHING_MS - 1000), now)).toBe(false);
    expect(isStalePublishing("published", at(STALE_PUBLISHING_MS * 10), now)).toBe(false);
  });
});

describe("postUrlFor", () => {
  test("builds a feed link from an activity id or URN, nothing from anything else", () => {
    expect(postUrlFor("7262000000000000000")).toBe("https://www.linkedin.com/feed/update/urn:li:activity:7262000000000000000/");
    expect(postUrlFor("urn:li:activity:7262")).toBe("https://www.linkedin.com/feed/update/urn:li:activity:7262/");
    expect(postUrlFor("urn:li:ugcPost:7262")).toBe("https://www.linkedin.com/feed/update/urn:li:ugcPost:7262/");
    expect(postUrlFor(null)).toBeNull();
    expect(postUrlFor("javascript:alert(1)")).toBeNull();
  });
});

describe("feed preview", () => {
  test("short posts show whole", () => {
    expect(feedPreview("One line")).toEqual({ shown: "One line", truncated: false });
    expect(feedPreview("a\nb\nc\n\n")).toEqual({ shown: "a\nb\nc", truncated: false });
  });
  test("cuts after three lines", () => {
    expect(feedPreview("a\nb\nc\nd")).toEqual({ shown: "a\nb\nc", truncated: true });
  });
  test("cuts a long first line at a word", () => {
    const preview = feedPreview(`${"word ".repeat(60)}end`);
    expect(preview.truncated).toBe(true);
    expect(preview.shown.length).toBeLessThanOrEqual(210);
    expect(preview.shown.endsWith("word")).toBe(true);
  });
  test("first line skips blanks", () => {
    expect(firstLine("\n\n  Hook here  \nmore")).toBe("Hook here");
    expect(firstLine("")).toBe("");
  });
});
