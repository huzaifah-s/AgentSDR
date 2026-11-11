import "server-only";

import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2Client } from "@/lib/platform/clients";
import { requirePlatformCredentials } from "@/lib/platform/credentials";
import { POST_IMAGE_TYPES } from "./contract";

/**
 * A post's images live in Cloudflare R2 (the organization's R2 integration)
 * at linkedin-posts/<post id>/<uuid>.<ext>, the same put / presign pattern as
 * src/lib/calls/storage.ts. The browser sees them only through short-lived
 * presigned links; publishing reads them back and hands them to Unipile.
 */

let cached: { key: string; client: S3Client } | undefined;

async function r2(): Promise<{ client: S3Client; bucket: string }> {
  const creds = await requirePlatformCredentials("r2");
  const key = [creds.accountId, creds.accessKeyId, creds.secretAccessKey].join("\n");
  if (cached?.key !== key) cached = { key, client: r2Client(creds) };
  return { client: cached.client, bucket: creds.bucket };
}

export function postImageKey(postId: string, file: string): string {
  return `linkedin-posts/${postId}/${file}`;
}

export function postImageFile(contentType: string): string {
  return `${crypto.randomUUID()}.${POST_IMAGE_TYPES[contentType]}`;
}

export async function putPostImage(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const { client, bucket } = await r2();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getPostImageBytes(key: string): Promise<Uint8Array> {
  const { client, bucket } = await r2();
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`Image ${key} has no body`);
  return response.Body.transformToByteArray();
}

export async function presignPostImage(key: string): Promise<string> {
  const { client, bucket } = await r2();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 60 * 60 });
}

export async function deletePostImages(keys: string[]): Promise<void> {
  if (!keys.length) return;
  const { client, bucket } = await r2();
  const result = await client.send(
    new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
  );
  if (result.Errors?.length) {
    throw new Error(`Could not delete ${result.Errors.length} image(s): ${result.Errors.map((e) => e.Message ?? e.Code).join("; ")}`);
  }
}
