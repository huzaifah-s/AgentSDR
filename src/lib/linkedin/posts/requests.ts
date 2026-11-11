/**
 * Request parsing for /api/linkedin/posts/*: pure, so the routes stay thin
 * and the rules are tested (requests.test.ts). Client-safe.
 */
import {
  MAX_POST_IMAGE_BYTES,
  MAX_POST_IMAGES,
  MAX_POST_LENGTH,
  POST_IMAGE_TYPES,
  POST_STATUSES,
  type LinkedinPostStatus,
} from "./contract";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPostId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export type ListQuery = {
  statuses: LinkedinPostStatus[] | null;
  linkedinAccountId: string | null;
  page: number;
  pageSize: number;
};

/** `?status=draft,failed&account=<id>&page=1&pageSize=25`. */
export function parseListQuery(params: URLSearchParams): Parsed<ListQuery> {
  let statuses: LinkedinPostStatus[] | null = null;
  const rawStatus = params.get("status");
  if (rawStatus) {
    const parts = [...new Set(rawStatus.split(",").map((part) => part.trim()).filter(Boolean))];
    const unknown = parts.find((part) => !(POST_STATUSES as readonly string[]).includes(part));
    if (unknown) return fail(`Unknown status: ${unknown}`);
    statuses = parts as LinkedinPostStatus[];
  }
  const account = params.get("account")?.trim() || null;
  if (account && account.length > 64) return fail("Unknown account");

  const page = params.get("page") ? Number(params.get("page")) : 1;
  if (!Number.isInteger(page) || page < 1) return fail("page must be a whole number from 1");
  const pageSize = params.get("pageSize") ? Number(params.get("pageSize")) : DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return fail(`pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}`);
  }
  return ok({ statuses, linkedinAccountId: account, page, pageSize });
}

function readBody(value: unknown): Parsed<string> {
  if (typeof value !== "string") return fail("body must be text");
  // LinkedIn keeps line breaks; normalise Windows ones so the count matches what is posted.
  const body = value.replace(/\r\n?/g, "\n");
  if (body.length > MAX_POST_LENGTH) return fail(`A post can be at most ${MAX_POST_LENGTH.toLocaleString("en-US")} characters.`);
  return ok(body);
}

function readAccountId(value: unknown): Parsed<string> {
  if (typeof value !== "string" || !value.trim() || value.length > 64) return fail("Choose a LinkedIn account");
  return ok(value.trim());
}

function asObject(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

export type CreatePostInput = { linkedinAccountId: string; body: string };

/** POST / — `{ linkedinAccountId, body? }`. A draft may be empty. */
export function parseCreatePost(input: unknown): Parsed<CreatePostInput> {
  const object = asObject(input);
  if (!object) return fail("Expected a JSON object");
  const account = readAccountId(object.linkedinAccountId);
  if (!account.ok) return account;
  const body = readBody(object.body ?? "");
  if (!body.ok) return body;
  return ok({ linkedinAccountId: account.value, body: body.value });
}

export type UpdatePostInput = { linkedinAccountId?: string; body?: string };

/** PATCH /[id] — any of `{ linkedinAccountId, body }`, at least one. */
export function parseUpdatePost(input: unknown): Parsed<UpdatePostInput> {
  const object = asObject(input);
  if (!object) return fail("Expected a JSON object");
  const update: UpdatePostInput = {};
  if (object.linkedinAccountId !== undefined) {
    const account = readAccountId(object.linkedinAccountId);
    if (!account.ok) return account;
    update.linkedinAccountId = account.value;
  }
  if (object.body !== undefined) {
    const body = readBody(object.body);
    if (!body.ok) return body;
    update.body = body.value;
  }
  if (update.linkedinAccountId === undefined && update.body === undefined) return fail("Nothing to change");
  return ok(update);
}

/** What the first bytes of a file say it is; null for anything but the four image types. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export type ImageUpload = { contentType: string; fileName: string; bytes: number };

/**
 * POST /[id]/images — one file. The type is taken from the file's own bytes
 * (the declared type must agree), so a renamed file cannot pass as an image.
 */
export function validateImageUpload(input: {
  declaredType: string;
  fileName: string;
  head: Uint8Array;
  size: number;
  existingCount: number;
}): Parsed<ImageUpload> {
  if (input.existingCount >= MAX_POST_IMAGES) return fail(`A post can have at most ${MAX_POST_IMAGES} images.`);
  if (input.size <= 0) return fail("The file is empty.");
  if (input.size > MAX_POST_IMAGE_BYTES) return fail(`An image can be at most ${MAX_POST_IMAGE_BYTES / (1024 * 1024)} MB.`);
  const sniffed = sniffImageType(input.head);
  if (!sniffed) return fail("Use a JPG, PNG, WebP or GIF image.");
  const declared = input.declaredType.toLowerCase().replace("image/jpg", "image/jpeg");
  if (declared && declared !== "application/octet-stream" && declared !== sniffed) {
    return fail("The file's type does not match its contents.");
  }
  const fileName = (input.fileName || `image.${POST_IMAGE_TYPES[sniffed]}`).replace(/[\u0000-\u001f"\\/]/g, "_").slice(0, 120);
  return ok({ contentType: sniffed, fileName, bytes: input.size });
}

/** GET / DELETE /[id]/images/[imageId] — the uuid part of the image's key. */
export function isImageId(value: string): boolean {
  return UUID_PATTERN.test(value);
}
