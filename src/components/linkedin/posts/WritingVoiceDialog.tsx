"use client";

import { useEffect, useState } from "react";
import { RiAddLine, RiDeleteBinLine, RiLoader4Line, RiMagicLine, RiQuillPenLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Modal from "@/components/alignui/modal";
import * as Textarea from "@/components/alignui/textarea";
import { Callout } from "@/components/settings/SettingsKit";
import { MAX_POST_LENGTH, type AuthorVoiceView } from "@/lib/linkedin/posts/contract";
import { MAX_VOICE_EXAMPLES, VOICE_BLOCK_HINTS } from "@/lib/linkedin/posts/postInstructions";

type Block = { id: string; title: string; content: string };

/** The hinted blocks first (filled from what is saved), then any of the person's own. */
function withHints(saved: Block[]): Block[] {
  const hinted = VOICE_BLOCK_HINTS.map((hint) => saved.find((block) => block.id === hint.id) ?? { id: hint.id, title: hint.title, content: "" });
  const own = saved.filter((block) => !VOICE_BLOCK_HINTS.some((hint) => hint.id === block.id));
  return [...hinted, ...own];
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data as T;
}

/**
 * A LinkedIn account's writing voice (Phase 5): titled blocks starting from
 * hints, up to 5 example posts, and "Learn from my posts", which fills the
 * blocks as a suggestion from the account's recent posts. Nothing is saved
 * until Save. Any member may edit it.
 */
export function WritingVoiceDialog({ accountId, accountLabel, onClose, onSaved }: { accountId: string; accountLabel: string; onClose: () => void; onSaved?: (voice: AuthorVoiceView) => void }) {
  const [loaded, setLoaded] = useState<AuthorVoiceView | null>(null);
  const [blocks, setBlocks] = useState<Block[]>(() => withHints([]));
  const [examples, setExamples] = useState<string[]>([]);
  const [busy, setBusy] = useState<"load" | "learn" | "save" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ voice: AuthorVoiceView }>(`/api/linkedin/posts/voices/${encodeURIComponent(accountId)}`)
      .then(({ voice }) => {
        if (cancelled) return;
        setLoaded(voice);
        setBlocks(withHints(voice.instructions));
        setExamples(voice.examplePosts);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setBusy(null));
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const setBlock = (id: string, change: Partial<Block>) => setBlocks((current) => current.map((block) => (block.id === id ? { ...block, ...change } : block)));

  async function learn() {
    setBusy("learn");
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ instructions: Block[]; postsRead: number }>(`/api/linkedin/posts/voices/${encodeURIComponent(accountId)}/learn`, { method: "POST" });
      setBlocks((current) => {
        const learned = new Map(result.instructions.map((block) => [block.id, block]));
        return current.map((block) => (learned.has(block.id) ? { ...block, content: learned.get(block.id)!.content } : block));
      });
      setNotice(`Filled from ${result.postsRead} recent post${result.postsRead === 1 ? "" : "s"}. Read it, change what is wrong, then save.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      const { voice } = await api<{ voice: AuthorVoiceView }>(`/api/linkedin/posts/voices/${encodeURIComponent(accountId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: blocks.filter((block) => block.content.trim()), examplePosts: examples.filter((post) => post.trim()) }),
      });
      onSaved?.(voice);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  const disabled = busy !== null;
  const tooLong = examples.some((post) => post.length > MAX_POST_LENGTH);

  return (
    <Modal.Root open onOpenChange={(open) => !open && busy !== "save" && onClose()}>
      <Modal.Content size="max-w-2xl" className="max-h-[calc(100dvh-2rem)]">
        <Modal.Header icon={RiQuillPenLine}>
          <Modal.Title>Writing voice</Modal.Title>
          <Modal.Description>
            How {accountLabel} sounds on LinkedIn. Post drafts follow it after the organization&apos;s brief (Settings → Instructions → LinkedIn posts), and a draft&apos;s own notes win for that post.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-paragraph-xs text-text-sub-600">
              {loaded?.updatedAt ? `Last saved${loaded.updatedBy?.name ? ` by ${loaded.updatedBy.name}` : ""} on ${new Date(loaded.updatedAt).toLocaleDateString()}.` : "Nothing saved yet."}
            </p>
            <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={learn} disabled={disabled}>
              <Button.Icon as={busy === "learn" ? RiLoader4Line : RiMagicLine} className={busy === "learn" ? "animate-spin" : undefined} />
              {busy === "learn" ? "Reading posts…" : "Learn from my posts"}
            </Button.Root>
          </div>
          {notice && <Callout tone="info">{notice}</Callout>}

          {blocks.map((block) => {
            const hint = VOICE_BLOCK_HINTS.find((item) => item.id === block.id);
            return (
              <div key={block.id}>
                {hint ? (
                  <label htmlFor={`voice-${block.id}`} className="mb-1.5 block text-label-sm text-text-strong-950">
                    {hint.title}
                  </label>
                ) : (
                  <Input.Root size="small" className="mb-1.5">
                    <Input.Wrapper>
                      <Input.Input aria-label="Block title" value={block.title} onChange={(event) => setBlock(block.id, { title: event.target.value })} placeholder="Title" disabled={disabled} />
                    </Input.Wrapper>
                  </Input.Root>
                )}
                <Textarea.Root
                  id={`voice-${block.id}`}
                  value={block.content}
                  onChange={(event) => setBlock(block.id, { content: event.target.value })}
                  rows={2}
                  placeholder={hint?.placeholder ?? "What else should every draft know about how this person writes?"}
                  disabled={disabled}
                />
              </div>
            );
          })}
          <Button.Root
            variant="neutral"
            mode="ghost"
            size="xsmall"
            onClick={() => setBlocks((current) => [...current, { id: crypto.randomUUID(), title: "", content: "" }])}
            disabled={disabled || blocks.length >= 20}
          >
            <Button.Icon as={RiAddLine} />
            Add a block
          </Button.Root>

          <div className="border-t border-stroke-soft-200 pt-4">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-label-sm text-text-strong-950">Example posts</span>
              <span className="text-paragraph-xs text-text-soft-400">
                {examples.length} of {MAX_VOICE_EXAMPLES}
              </span>
            </div>
            <p className="mb-2 text-paragraph-xs text-text-sub-600">Posts that sound like this person, their own or anyone&apos;s. Drafts copy the style, never the content.</p>
            <div className="space-y-2">
              {examples.map((post, index) => (
                <div key={index} className="flex gap-2">
                  <Textarea.Root
                    aria-label={`Example post ${index + 1}`}
                    value={post}
                    onChange={(event) => setExamples((current) => current.map((value, i) => (i === index ? event.target.value : value)))}
                    rows={3}
                    disabled={disabled}
                    className="flex-1"
                  />
                  <Button.Root
                    variant="neutral"
                    mode="ghost"
                    size="xsmall"
                    aria-label={`Remove example post ${index + 1}`}
                    onClick={() => setExamples((current) => current.filter((_, i) => i !== index))}
                    disabled={disabled}
                  >
                    <Button.Icon as={RiDeleteBinLine} />
                  </Button.Root>
                </div>
              ))}
            </div>
            {tooLong && <p className="mt-1 text-paragraph-xs text-error-base">An example post can be at most {MAX_POST_LENGTH.toLocaleString()} characters.</p>}
            <Button.Root variant="neutral" mode="ghost" size="xsmall" className="mt-2" onClick={() => setExamples((current) => [...current, ""])} disabled={disabled || examples.length >= MAX_VOICE_EXAMPLES}>
              <Button.Icon as={RiAddLine} />
              Add an example post
            </Button.Root>
          </div>

          {error && <Callout tone="error">{error}</Callout>}
        </Modal.Body>
        <Modal.Footer>
          <Button.Root variant="neutral" mode="stroke" size="small" onClick={onClose} disabled={busy === "save"}>
            Cancel
          </Button.Root>
          <Button.Root variant="primary" mode="filled" size="small" onClick={save} disabled={disabled || tooLong}>
            {busy === "save" && <Button.Icon as={RiLoader4Line} className="animate-spin" />}
            {busy === "save" ? "Saving…" : "Save voice"}
          </Button.Root>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
