import "server-only";

import type { LinkedinPostSource } from "./contract";
import { describeLeaks, findLeaks, type LeakTerm } from "./leakGuard";
import { guardTermsFor } from "./themes.server";

/**
 * The leak guard on a saved post (Phase 4): run when a post written from
 * prospects' themes is scheduled and again when it is published, against
 * the people in its theme's source set, so an edit cannot bring a prospect's
 * name in after the drafts were checked. Posts from any other source pass.
 */

type Reader = Parameters<typeof guardTermsFor>[1];

/** The time the theme's messages were read; a source without one falls back to the post's creation. */
function readAtOf(source: LinkedinPostSource, createdAt: Date): Date {
  const at = source.themesReadAt ? new Date(source.themesReadAt) : null;
  return at && !Number.isNaN(at.getTime()) ? at : createdAt;
}

/** The refusal message when the post names someone from its source conversations; null when it is clear. */
export async function conversationsLeakMessage(
  post: { source: LinkedinPostSource | null; body: string; createdAt: Date },
  reader?: Reader,
  terms?: (readAt: Date) => Promise<LeakTerm[]>,
): Promise<string | null> {
  if (post.source?.kind !== "conversations") return null;
  const readAt = readAtOf(post.source, post.createdAt);
  const found = findLeaks(post.body, await (terms ? terms(readAt) : guardTermsFor(readAt, reader)));
  if (!found.length) return null;
  return `This post was written from what prospects said, and it names someone from those conversations: ${describeLeaks(found)}. Take it out before posting.`;
}
