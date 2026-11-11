import "server-only";

import { createHmac, timingSafeEqual } from "crypto";

/**
 * The server's seal on a prospects' theme (Phase 4). A theme reaches the
 * browser and comes back with /generate, /rewrite and the post's `source`;
 * the seal is what makes `source.kind = 'conversations'` something only the
 * server writes: the browser cannot invent a theme, or move the time its
 * messages were read, which is what the leak guard checks the post against
 * again at publish.
 *
 * HMAC-SHA256 keyed from INTEGRATION_CREDENTIALS_KEY (always set where
 * integrations are), over the organization, the read time, the title and
 * the summary. Stateless, so nothing about the theme is stored but the post.
 */

const CONTEXT = "agentsdr:linkedin-post-theme:v1";

function key(secret?: string): string {
  const value = secret ?? process.env.INTEGRATION_CREDENTIALS_KEY;
  if (!value) throw new Error("INTEGRATION_CREDENTIALS_KEY must be configured to use prospects' themes");
  return value;
}

export type SealedFields = { organizationId: string; readAt: string; title: string; summary: string };

export function sealTheme(fields: SealedFields, secret?: string): string {
  return createHmac("sha256", key(secret))
    .update(JSON.stringify([CONTEXT, fields.organizationId, fields.readAt, fields.title, fields.summary]))
    .digest("base64url");
}

export function themeSealValid(fields: SealedFields, seal: string, secret?: string): boolean {
  const expected = Buffer.from(sealTheme(fields, secret));
  const given = Buffer.from(seal);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
