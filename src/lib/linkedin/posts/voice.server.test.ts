import { describe, expect, test } from "bun:test";
import { runInOrganization } from "@/lib/tenancy/scope";
import { createVoiceLoader, pastPostTexts, VOICE_CACHE_MS, type PastPostsReader } from "./voice.server";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const account = { id: "acc-1", linkedinId: "unipile-1", name: "Priya Shah", headline: "Head of Sales" };

function reader(texts: string[]) {
  const calls: string[] = [];
  let fail = false;
  const read: PastPostsReader = async (unipileAccountId) => {
    calls.push(unipileAccountId);
    if (fail) throw new Error("Unipile down");
    return texts;
  };
  return { read, calls, setFail: (value: boolean) => (fail = value) };
}

describe("pastPostTexts", () => {
  test("keeps the author's own posts, newest first, and leaves out reposts and empty ones", () => {
    const items = [
      { text: "  Newest post\r\nline two " },
      { text: "Someone else's post", is_repost: true },
      { text: "   " },
      { text: 42 },
      { text: "Older post" },
    ];
    expect(pastPostTexts(items)).toEqual(["Newest post\nline two", "Older post"]);
  });

  test("stops at the limit", () => {
    expect(pastPostTexts([{ text: "1" }, { text: "2" }, { text: "3" }], 2)).toEqual(["1", "2"]);
  });
});

describe("loadAuthorVoice", () => {
  test("reads once an hour per organization and account", async () => {
    let now = 1_000;
    const fake = reader(["A post"]);
    const { loadAuthorVoice } = createVoiceLoader({ read: fake.read, now: () => now });

    const first = await runInOrganization(ORG_A, () => loadAuthorVoice(account));
    expect(first).toEqual({ name: "Priya Shah", headline: "Head of Sales", pastPosts: ["A post"], status: "read" });
    await runInOrganization(ORG_A, () => loadAuthorVoice(account));
    expect(fake.calls).toEqual(["unipile-1"]);

    // Another organization never shares the first one's cache.
    await runInOrganization(ORG_B, () => loadAuthorVoice(account));
    expect(fake.calls).toHaveLength(2);

    now += VOICE_CACHE_MS;
    await runInOrganization(ORG_A, () => loadAuthorVoice(account));
    expect(fake.calls).toHaveLength(3);
  });

  test("an account with no posts gets status none", async () => {
    const { loadAuthorVoice } = createVoiceLoader({ read: reader([]).read });
    expect((await runInOrganization(ORG_A, () => loadAuthorVoice(account))).status).toBe("none");
  });

  test("a failed read is unavailable, not cached, and never throws", async () => {
    const fake = reader(["A post"]);
    fake.setFail(true);
    const { loadAuthorVoice } = createVoiceLoader({ read: fake.read });
    const failed = await runInOrganization(ORG_A, () => loadAuthorVoice(account));
    expect(failed).toEqual({ name: "Priya Shah", headline: "Head of Sales", pastPosts: [], status: "unavailable" });
    fake.setFail(false);
    expect((await runInOrganization(ORG_A, () => loadAuthorVoice(account))).status).toBe("read");
    expect(fake.calls).toHaveLength(2);
  });

  test("needs an organization in scope", async () => {
    const { loadAuthorVoice } = createVoiceLoader({ read: reader([]).read });
    await expect(loadAuthorVoice(account)).rejects.toThrow();
  });
});
