import "server-only";

import { currentOrganizationId } from "@/lib/tenancy/scope";
import { serializeError } from "@/lib/linkedin/serializeError";
import { getUnipileClient } from "@/services/unipile.service";
import { MAX_POST_LENGTH, type PostVoiceStatus } from "./contract";

/**
 * The author's voice for an AI draft: their name and headline, and the
 * account's own recent posts, read through Unipile (`users.getOwnProfile`
 * for the account's own LinkedIn provider id, then `users.getAllPosts`).
 *
 * Cached an hour per (organization, account), so a rep trying several drafts
 * reads LinkedIn once. A failed read is not cached, and never stops a draft:
 * the prompt then says there are no past posts and asks for a plain voice.
 */

export const VOICE_CACHE_MS = 60 * 60 * 1000;
/** Past posts read per account ("the last ~10"). */
export const VOICE_PAST_POSTS = 10;

/** The account a draft is written for, as read from the organization's own rows. */
export type VoiceAccount = {
  id: string;
  /** The Unipile account id. */
  linkedinId: string;
  name: string | null;
  headline: string | null;
};

export type AuthorVoice = {
  name: string | null;
  headline: string | null;
  /** Newest first, reposts left out. */
  pastPosts: string[];
  status: PostVoiceStatus;
};

/** Reads an account's own past posts' text; throws when Unipile cannot be read. */
export type PastPostsReader = (unipileAccountId: string, limit: number) => Promise<string[]>;

type UnipilePostItem = { text?: unknown; is_repost?: unknown };

/** The texts worth learning a voice from: the author's own posts, not reposts or empty ones. Pure. */
export function pastPostTexts(items: readonly UnipilePostItem[], limit = VOICE_PAST_POSTS): string[] {
  const texts: string[] = [];
  for (const item of items) {
    if (texts.length >= limit) break;
    if (item.is_repost === true || typeof item.text !== "string") continue;
    const text = item.text.replace(/\r\n?/g, "\n").trim();
    if (text) texts.push(text.slice(0, MAX_POST_LENGTH));
  }
  return texts;
}

export const readPastPostsFromUnipile: PastPostsReader = async (unipileAccountId, limit) => {
  const client = await getUnipileClient();
  const me = (await client.users.getOwnProfile(unipileAccountId)) as { provider_id?: unknown };
  const providerId = typeof me.provider_id === "string" ? me.provider_id.trim() : "";
  if (!providerId) throw new Error("Unipile returned no provider id for the account's own profile");
  // Asks for a few more than needed: reposts are left out.
  const list = (await client.users.getAllPosts({ identifier: providerId, account_id: unipileAccountId, limit: limit + 5 })) as {
    items?: UnipilePostItem[];
  };
  return pastPostTexts(list.items ?? [], limit);
};

export function createVoiceLoader(dependencies: { read?: PastPostsReader; now?: () => number } = {}) {
  const read = dependencies.read ?? readPastPostsFromUnipile;
  const now = dependencies.now ?? Date.now;
  const cache = new Map<string, { at: number; pastPosts: string[] }>();

  async function loadAuthorVoice(account: VoiceAccount): Promise<AuthorVoice> {
    const identity = { name: account.name?.trim() || null, headline: account.headline?.trim() || null };
    // The Unipile id is in the key too: an account reconnected under a new id is a new read.
    const key = `${currentOrganizationId()}:${account.id}:${account.linkedinId}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < VOICE_CACHE_MS) {
      return { ...identity, pastPosts: hit.pastPosts, status: hit.pastPosts.length ? "read" : "none" };
    }
    try {
      const pastPosts = await read(account.linkedinId, VOICE_PAST_POSTS);
      cache.set(key, { at: now(), pastPosts });
      return { ...identity, pastPosts, status: pastPosts.length ? "read" : "none" };
    } catch (error) {
      console.warn("[linkedin/posts] could not read the author's past posts", { accountId: account.id, error: serializeError(error) });
      return { ...identity, pastPosts: [], status: "unavailable" };
    }
  }

  return { loadAuthorVoice, clear: () => cache.clear() };
}

const shared = createVoiceLoader();

/** The author's voice, cached an hour per (organization, account). */
export const loadAuthorVoice = shared.loadAuthorVoice;
