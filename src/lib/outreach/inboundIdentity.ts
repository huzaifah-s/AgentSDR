/** Stable, mailbox-scoped identity for one Gmail delivery. */
export function gmailInboundEventKey(mailboxAddress: string, gmailMessageId: string) {
  const mailbox = mailboxAddress.trim().toLowerCase();
  const messageId = gmailMessageId.trim();
  if (!mailbox || !messageId) throw new Error("Gmail event identity requires mailbox and message ID");
  return `gmail:${mailbox}:${messageId}`;
}

/** Stable, mailbox-scoped identity for one IMAP delivery (`id` is its Message-ID, else its UID). */
export function imapInboundEventKey(mailboxAddress: string, id: string) {
  const mailbox = mailboxAddress.trim().toLowerCase();
  const messageId = id.trim();
  if (!mailbox || !messageId) throw new Error("IMAP event identity requires mailbox and message ID");
  return `imap:${mailbox}:${messageId}`;
}

/** The durable key of an inbound message, by where it was read. */
export function inboundEventKey(mailboxAddress: string, msg: { source?: "gmail" | "imap"; gmailMessageId: string }) {
  return msg.source === "imap"
    ? imapInboundEventKey(mailboxAddress, msg.gmailMessageId)
    : gmailInboundEventKey(mailboxAddress, msg.gmailMessageId);
}
