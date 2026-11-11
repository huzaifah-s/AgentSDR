import { requirePlatformCredentials } from "@/lib/platform/credentials";

/**
 * Publishing a LinkedIn post through Unipile (`POST /api/v1/posts`,
 * multipart). Called directly rather than through the SDK: its `createPost`
 * types only `{ object }` back, and its `extra_params` take strings only, so
 * images cannot go through it.
 *
 * The caller decides what an outcome means (src/lib/linkedin/posts/publish.ts):
 * this file only says whether Unipile answered, and how. It never retries —
 * a second request after a lost answer could post twice.
 */

/** How long to wait for Unipile before treating the publish as uncertain. */
const PUBLISH_TIMEOUT_MS = 90_000;

export type PostImage = { bytes: Uint8Array; contentType: string; fileName: string };

export type CreateLinkedinPostResult = {
  /** Unipile's post id; null when Unipile did not return one (it may not). */
  postId: string | null;
};

/**
 * Unipile answered and refused (`refused`: a 4xx, nothing was posted), or the
 * outcome is unknown (`uncertain`: a timeout, a dropped connection, a 5xx or
 * an answer we cannot read — the post may be live).
 */
export class UnipilePostError extends Error {
  constructor(
    readonly kind: "refused" | "uncertain",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "UnipilePostError";
  }
}

/** Unipile's error body: `{ title, detail, type, status }`, any of them optional. */
function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const parts = [record.title, record.detail].filter((part): part is string => typeof part === "string" && Boolean(part.trim()));
    if (parts.length) return parts.join(": ");
    if (typeof record.message === "string") return record.message;
  }
  return `Unipile answered ${status}`;
}

export async function createLinkedinPost({
  accountId,
  text,
  images = [],
}: {
  /** The Unipile account id ("LinkedInAccount"."linkedinId"). */
  accountId: string;
  text: string;
  images?: PostImage[];
}): Promise<CreateLinkedinPostResult> {
  const { baseUrl, apiKey } = await requirePlatformCredentials("unipile");

  const form = new FormData();
  form.append("account_id", accountId);
  form.append("text", text);
  for (const image of images) {
    form.append("attachments", new Blob([image.bytes as BlobPart], { type: image.contentType }), image.fileName);
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1/posts`, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new UnipilePostError("uncertain", timedOut ? "Unipile did not answer in time" : `Could not reach Unipile: ${error instanceof Error ? error.message : String(error)}`);
  }

  const raw = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }

  // 408 is a timeout on Unipile's side, after which the post may still go out.
  if (response.status >= 400 && response.status < 500 && response.status !== 408) {
    throw new UnipilePostError("refused", errorMessage(body, response.status), response.status);
  }
  if (!response.ok) {
    throw new UnipilePostError("uncertain", errorMessage(body, response.status), response.status);
  }

  const postId = body && typeof body === "object" ? (body as Record<string, unknown>).post_id : undefined;
  if (postId !== undefined && postId !== null && typeof postId !== "string" && typeof postId !== "number") {
    throw new UnipilePostError("uncertain", "Unipile's answer had an unexpected post id", response.status);
  }
  return { postId: postId === undefined || postId === null || postId === "" ? null : String(postId) };
}
