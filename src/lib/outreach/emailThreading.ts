/**
 * Threads for mailboxes without Gmail's thread ids (SMTP + IMAP).
 *
 * Gmail hands back a threadId with every message, and the CRM keys an email
 * conversation by it (crm_conversations.provider_thread_id). Plain SMTP has no
 * such thing, so an SMTP/IMAP thread is named by its root: the Message-ID of
 * the first message, which every reply carries as the first entry of
 * References (RFC 5322 §3.6.4 says to keep it when trimming the list). A send
 * that starts a thread is its own root; one that continues a thread keeps the
 * root it was given. Pure.
 */

/** Every `<id>` token in a Message-ID / In-Reply-To / References header, in order. */
export function parseMessageIdList(value: string | string[] | null | undefined): string[] {
  if (!value) return [];
  const text = Array.isArray(value) ? value.join(" ") : value;
  const ids = text.match(/<[^<>\s]+>/g);
  if (ids) return ids;
  // A bare id without angle brackets (some clients, and mailparser for a single value).
  return text.split(/\s+/).filter((token) => token.includes("@")).map((token) => `<${token.replace(/^<|>$/g, "")}>`);
}

/** A fresh RFC 5322 Message-ID on the sender's own domain. */
export function newMessageId(fromAddress: string, random: () => string = () => crypto.randomUUID()): string {
  const at = fromAddress.lastIndexOf("@");
  const domain = at === -1 ? "agentsdr.local" : fromAddress.slice(at + 1).toLowerCase();
  return `<${random()}@${domain}>`;
}

/**
 * The thread an SMTP send belongs to: the thread it was asked to continue,
 * else the root of the chain it replies to, else itself.
 */
export function smtpSendThreadId(params: { threadId?: string | null; references?: string[] | null; inReplyTo?: string | null }, messageId: string): string {
  return params.threadId || params.references?.find(Boolean) || params.inReplyTo || messageId;
}

/**
 * The thread an inbound message belongs to, by its headers alone: the first
 * References entry, else In-Reply-To, else the message itself (it starts a
 * thread). `candidates` (the same ids, every one) lets the caller look for a
 * thread it already knows when a client dropped the root.
 */
export function inboundThreadRoot(headers: { references?: string[]; inReplyTo?: string | null; messageId?: string | null }): {
  root: string | null;
  candidates: string[];
} {
  const references = headers.references ?? [];
  const inReplyTo = headers.inReplyTo ? parseMessageIdList(headers.inReplyTo)[0] ?? null : null;
  const candidates = [...new Set([...references, ...(inReplyTo ? [inReplyTo] : [])])];
  return { root: references[0] ?? inReplyTo ?? headers.messageId ?? null, candidates };
}
