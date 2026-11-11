import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

// The integration store is the only dependency; give it fixed credentials.
mock.module("@/lib/platform/credentials", () => ({
  requirePlatformCredentials: async () => ({ baseUrl: "https://unipile.test", apiKey: "key-1" }),
}));

let createLinkedinPost: typeof import("./unipile.posts").createLinkedinPost;
let UnipilePostError: typeof import("./unipile.posts").UnipilePostError;
beforeAll(async () => {
  ({ createLinkedinPost, UnipilePostError } = await import("./unipile.posts"));
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return calls;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UnipilePostError);
    return error as InstanceType<typeof UnipilePostError>;
  }
  throw new Error("expected a failure");
}

const post = () =>
  createLinkedinPost({
    accountId: "acc_1",
    text: "Hello",
    images: [{ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", fileName: "a.png" }],
  });

describe("createLinkedinPost", () => {
  test("sends one multipart request with the account, text and images", async () => {
    const calls = answer(201, { object: "PostCreated", post_id: "7262" });
    expect(await post()).toEqual({ postId: "7262" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://unipile.test/api/v1/posts");
    expect((calls[0].init.headers as Record<string, string>)["X-API-KEY"]).toBe("key-1");
    const form = calls[0].init.body as FormData;
    expect(form.get("account_id")).toBe("acc_1");
    expect(form.get("text")).toBe("Hello");
    expect(form.getAll("attachments")).toHaveLength(1);
  });

  test("a null or missing post id is a post with no id", async () => {
    answer(201, { object: "PostCreated", post_id: null });
    expect(await post()).toEqual({ postId: null });
    answer(201, "");
    expect(await post()).toEqual({ postId: null });
  });

  test("a 4xx is a refusal, with Unipile's reason", async () => {
    answer(422, { title: "Unprocessable", detail: "Text too long" });
    const error = await failure(post());
    expect(error.kind).toBe("refused");
    expect(error.message).toBe("Unprocessable: Text too long");
  });

  test("a 5xx, a 408, a timeout or a dropped connection is uncertain", async () => {
    answer(502, "bad gateway");
    expect((await failure(post())).kind).toBe("uncertain");
    answer(408, {});
    expect((await failure(post())).kind).toBe("uncertain");

    globalThis.fetch = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    const timeout = await failure(post());
    expect(timeout.kind).toBe("uncertain");
    expect(timeout.message).toContain("did not answer in time");

    globalThis.fetch = (async () => {
      throw new TypeError("socket hang up");
    }) as unknown as typeof fetch;
    expect((await failure(post())).kind).toBe("uncertain");
  });
});
