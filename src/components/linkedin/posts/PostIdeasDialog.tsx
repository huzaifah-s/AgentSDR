"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RiArrowRightLine, RiLightbulbLine, RiLoader4Line } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Modal from "@/components/alignui/modal";
import * as Select from "@/components/alignui/select";
import { Callout } from "@/components/settings/SettingsKit";
import { POST_IDEA_COUNT, THEME_WINDOW_DAYS, type LinkedinPostAccount, type LinkedinPostView, type PostIdea, type PostIdeasResponse } from "@/lib/linkedin/posts/contract";

async function api<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data as T;
}

function sourceLabel(idea: PostIdea): string {
  if (idea.source.kind === "conversations") return "From what prospects say";
  if (idea.source.kind === "knowledge") return "From Knowledge";
  return "From the brief";
}

/**
 * "Suggest ideas" on the Posts page (Phase 5): five ideas from the content
 * brief, public Knowledge and prospects' themes. Each opens as a draft on
 * the chosen account, with the idea as its topic (and its Knowledge or
 * theme), ready for "Write drafts" in the composer.
 */
export function PostIdeasDialog({ accounts }: { accounts: LinkedinPostAccount[] }) {
  const router = useRouter();
  const connected = accounts.filter((account) => account.status === "CONNECTED");
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState(connected[0]?.id ?? "");
  const [includeThemes, setIncludeThemes] = useState(true);
  const [busy, setBusy] = useState<"ideas" | number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<PostIdeasResponse | null>(null);

  if (!connected.length) return null;

  async function suggest() {
    setBusy("ideas");
    setError(null);
    try {
      setAnswer(await api<PostIdeasResponse>("/api/linkedin/posts/ideas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ includeThemes }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function open_(idea: PostIdea, index: number) {
    setBusy(index);
    setError(null);
    try {
      const { post } = await api<{ post: LinkedinPostView }>("/api/linkedin/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedinAccountId: accountId, body: "", source: idea.source }),
      });
      router.push(`/linkedin/posts/${post.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <>
      <Button.Root variant="neutral" mode="stroke" size="small" onClick={() => setOpen(true)}>
        <Button.Icon as={RiLightbulbLine} />
        Suggest ideas
      </Button.Root>
      {open && (
        <Modal.Root open onOpenChange={(next) => !next && busy === null && setOpen(false)}>
          <Modal.Content size="max-w-2xl" className="max-h-[calc(100dvh-2rem)]">
            <Modal.Header icon={RiLightbulbLine}>
              <Modal.Title>Post ideas</Modal.Title>
              <Modal.Description>
                {POST_IDEA_COUNT} ideas from your content brief (Settings → Instructions → LinkedIn posts), Knowledge marked public and, if you like, what prospects said in the last {THEME_WINDOW_DAYS} days. Each opens as a draft.
              </Modal.Description>
            </Modal.Header>
            <Modal.Body className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="mb-1.5 block text-label-sm text-text-strong-950" htmlFor="ideas-account">
                    Post as
                  </label>
                  <Select.Root value={accountId} onValueChange={setAccountId} size="small">
                    <Select.Trigger id="ideas-account" className="w-64">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      {connected.map((account) => (
                        <Select.Item key={account.id} value={account.id}>
                          {account.name || account.username}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </div>
                <label className="flex cursor-pointer items-center gap-2 pb-2 text-paragraph-sm text-text-strong-950">
                  <Checkbox.Root checked={includeThemes} onCheckedChange={(checked) => setIncludeThemes(checked === true)} disabled={busy !== null} />
                  Include what prospects say
                </label>
                <Button.Root variant="primary" mode="lighter" size="small" onClick={suggest} disabled={busy !== null} className="mb-px">
                  <Button.Icon as={busy === "ideas" ? RiLoader4Line : RiLightbulbLine} className={busy === "ideas" ? "animate-spin" : undefined} />
                  {busy === "ideas" ? "Thinking…" : answer ? "Suggest again" : "Suggest"}
                </Button.Root>
              </div>

              {answer && (
                <ul className="space-y-2">
                  {answer.ideas.map((idea, index) => (
                    <li key={`${idea.title}-${index}`} className="rounded-xl bg-bg-weak-50 p-3 ring-1 ring-inset ring-stroke-soft-200">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-label-sm text-text-strong-950">{idea.title}</p>
                          <p className="mt-0.5 text-paragraph-sm text-text-sub-600">{idea.angle}</p>
                          <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <Badge.Root size="small" variant="lighter" color="gray">{sourceLabel(idea)}</Badge.Root>
                            {idea.pillar && <Badge.Root size="small" variant="lighter" color="blue">{idea.pillar}</Badge.Root>}
                          </p>
                        </div>
                        <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => open_(idea, index)} disabled={busy !== null || !accountId}>
                          {busy === index ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <Button.Icon as={RiArrowRightLine} />}
                          Write this
                        </Button.Root>
                      </div>
                    </li>
                  ))}
                  {answer.withheld > 0 && (
                    <li className="text-paragraph-xs text-text-soft-400">
                      {answer.withheld} idea{answer.withheld === 1 ? " was" : "s were"} held back for naming someone from the conversations.
                    </li>
                  )}
                </ul>
              )}
              {error && <Callout tone="error">{error}</Callout>}
            </Modal.Body>
            <Modal.Footer>
              <Button.Root variant="neutral" mode="stroke" size="small" onClick={() => setOpen(false)} disabled={busy !== null}>
                Close
              </Button.Root>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      )}
    </>
  );
}
