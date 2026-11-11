"use client";

import { useMemo, useState } from "react";
import { RiArrowDownSLine, RiBookOpenLine, RiChat3Line, RiErrorWarningLine, RiLoader4Line, RiMagicLine, RiQuillPenLine, RiShieldCheckLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";
import * as Popover from "@/components/alignui/popover";
import * as Textarea from "@/components/alignui/textarea";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import {
  isAlwaysAddedKnowledge,
  KNOWLEDGE_KIND_LABELS,
  MAX_PICKED_KNOWLEDGE,
  MAX_REWRITE_INSTRUCTION_LENGTH,
  MAX_TOPIC_LENGTH,
  POST_DRAFT_VARIANTS,
  THEME_KIND_LABELS,
  THEME_WINDOW_DAYS,
  type LinkedinPostSource,
  type PostDraftsResponse,
  type PostKnowledgeOption,
  type PostTheme,
  type PostThemesResponse,
} from "@/lib/linkedin/posts/contract";
import { cn } from "@/utils/cn";

const REWRITE_SUGGESTIONS = ["Shorter", "Less salesy", "Lead with the number", "More personal"];

type Props = {
  accountId: string;
  authorName: string;
  body: string;
  knowledge: PostKnowledgeOption[];
  /** How the text in the editor was written, so a rewrite of a post from a theme keeps its theme (and its leak guard). */
  currentSource: LinkedinPostSource | null;
  disabled: boolean;
  /** The rep chose a draft or a rewrite. */
  onUse: (draft: { body: string }, answer: PostDraftsResponse, kind: "draft" | "rewrite") => void;
};

async function ask<T = PostDraftsResponse>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data as T;
}

/** The theme a saved post was written from, to send back with a rewrite. */
function themeOfSource(source: LinkedinPostSource | null): PostTheme | null {
  if (source?.kind !== "conversations" || !source.themeTitle || !source.themeSummary || !source.themesReadAt || !source.seal) return null;
  return { title: source.themeTitle, summary: source.themeSummary, readAt: source.themesReadAt, seal: source.seal, kind: "other", mentions: 1 };
}

function withheldNote(answer: PostDraftsResponse): string | null {
  const count = answer.withheld.length;
  if (!count) return null;
  const what = answer.withheld.map((item) => item.matched).join("; ");
  const drafts = count === 1 ? "One draft was" : `${count} drafts were`;
  return `${drafts} held back because ${count === 1 ? "it named" : "they named"} someone from the conversations: ${what}.${answer.variants.length ? "" : " Try again."}`;
}

function voiceNote(answer: PostDraftsResponse, authorName: string): string {
  if (answer.voice.status === "read") return `Written to sound like ${authorName}'s last ${answer.voice.pastPosts} post${answer.voice.pastPosts === 1 ? "" : "s"}.`;
  if (answer.voice.status === "none") return `${authorName} has no posts to learn from yet, so this is a plain first-person voice.`;
  return `${authorName}'s past posts could not be read, so this is a plain first-person voice.`;
}

/**
 * "Write with AI" in the composer: drafts from a topic and Knowledge, and a
 * rewrite of the current text. Shown only when OpenRouter is connected.
 */
export function PostAiPanel({ accountId, authorName, body, knowledge, currentSource, disabled, onUse }: Props) {
  const [topic, setTopic] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<"draft" | "rewrite" | "themes" | null>(null);
  const [themes, setThemes] = useState<PostThemesResponse | null>(null);
  const [theme, setTheme] = useState<PostTheme | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ kind: "draft" | "rewrite"; response: PostDraftsResponse } | null>(null);

  const alwaysAdded = useMemo(() => knowledge.filter(isAlwaysAddedKnowledge), [knowledge]);
  const chosen = knowledge.filter((document) => picked.includes(document.id));
  const notPublic = chosen.filter((document) => !document.isPublic);
  const sources = { linkedinAccountId: accountId, topic: topic.trim() || null, knowledgeDocumentIds: picked, ...(theme ? { theme } : {}) };
  // A rewrite of a post from a theme sends the theme back, so the rewrite is guarded and keeps its source.
  const rewriteTheme = theme ?? themeOfSource(currentSource);
  const canDraft = !disabled && !busy && Boolean(accountId) && (Boolean(topic.trim()) || picked.length > 0 || Boolean(theme));
  const canRewrite = !disabled && !busy && Boolean(accountId) && Boolean(body.trim()) && Boolean(instruction.trim());

  const toggle = (id: string, on: boolean) =>
    setPicked((current) => (on ? (current.includes(id) ? current : [...current, id].slice(0, MAX_PICKED_KNOWLEDGE)) : current.filter((value) => value !== id)));

  async function findThemes() {
    setBusy("themes");
    setError(null);
    try {
      const found = await ask<PostThemesResponse>("/api/linkedin/posts/themes", {});
      setThemes(found);
      setTheme(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function run(kind: "draft" | "rewrite") {
    setBusy(kind);
    setError(null);
    try {
      const response =
        kind === "draft"
          ? await ask("/api/linkedin/posts/generate", sources)
          : await ask("/api/linkedin/posts/rewrite", {
              ...sources,
              ...(rewriteTheme ? { theme: rewriteTheme } : {}),
              body,
              instruction: instruction.trim(),
            });
      setAnswer({ kind, response });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Frame>
      <FrameHeader title="Write with AI" description="Drafts from a topic and your Knowledge, in the voice of the person posting. Nothing is saved until you use one." />
      <FramePanel className="space-y-4">
        <div>
          <label className="mb-1.5 block text-label-sm text-text-strong-950" htmlFor="post-topic">
            Topic
          </label>
          <Textarea.Root
            id="post-topic"
            value={topic}
            onChange={(event) => setTopic(event.target.value.slice(0, MAX_TOPIC_LENGTH))}
            rows={2}
            placeholder="A line or two, e.g. why we stopped cold-calling before 10 am"
            disabled={disabled}
          />
        </div>

        <div>
          <span className="mb-1.5 block text-label-sm text-text-strong-950">Knowledge</span>
          <Popover.Root>
            <Popover.Trigger asChild disabled={disabled || knowledge.length === 0}>
              <button
                type="button"
                aria-label="Knowledge documents"
                className="flex h-9 w-full items-center gap-2 rounded-lg bg-bg-white-0 px-3 text-left text-paragraph-sm text-text-strong-950 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50 disabled:cursor-not-allowed disabled:text-text-disabled-300"
              >
                <RiBookOpenLine className="size-4 shrink-0 text-text-soft-400" />
                <span className="min-w-0 flex-1 truncate" title={chosen.map((document) => document.title).join(", ")}>
                  {knowledge.length === 0 ? "No Knowledge documents yet" : chosen.length ? chosen.map((document) => document.title).join(", ") : "Choose documents (optional)"}
                </span>
                <RiArrowDownSLine className="size-4 shrink-0 text-text-soft-400" />
              </button>
            </Popover.Trigger>
            <Popover.Content align="start" showArrow={false} sideOffset={6} className="w-[min(28rem,calc(100vw-2rem))] p-0">
              <ul className="max-h-72 overflow-y-auto py-1">
                {knowledge.map((document) => (
                  <li key={document.id}>
                    <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-bg-weak-50">
                      <Checkbox.Root className="mt-0.5" checked={picked.includes(document.id)} onCheckedChange={(checked) => toggle(document.id, checked === true)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-label-sm text-text-strong-950">{document.title}</span>
                        <span className="block text-paragraph-xs text-text-sub-600">
                          {KNOWLEDGE_KIND_LABELS[document.kind] ?? document.kind} · {document.chars.toLocaleString()} characters
                          {document.isPublic ? " · public" : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </Popover.Content>
          </Popover.Root>
          {notPublic.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {notPublic.map((document) => (
                <li key={document.id} className="flex gap-1.5 text-paragraph-xs text-warning-base">
                  <RiErrorWarningLine className="mt-px size-3.5 shrink-0" />
                  <span>
                    <span className="font-medium">{document.title}</span>: This document is not marked public. Check the draft for pricing or client names before posting.
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-paragraph-xs text-text-sub-600">
            Always added:{" "}
            {alwaysAdded.length
              ? alwaysAdded.map((document) => document.title).join(", ")
              : "nothing yet. Knowledge marked “Always include” and tagged public is added to every draft."}
          </p>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-label-sm text-text-strong-950">What prospects say</span>
            <Button.Root variant="neutral" mode="ghost" size="xxsmall" onClick={findThemes} disabled={disabled || Boolean(busy)}>
              <Button.Icon as={busy === "themes" ? RiLoader4Line : RiChat3Line} className={cn(busy === "themes" && "animate-spin")} />
              {busy === "themes" ? "Reading…" : themes ? "Find again" : "Find themes"}
            </Button.Root>
          </div>
          {!themes ? (
            <p className="text-paragraph-xs text-text-sub-600">
              Objections, questions and pain points from the last {THEME_WINDOW_DAYS} days of replies and calls. A draft is written from the theme&apos;s summary only, never from the messages.
            </p>
          ) : themes.themes.length === 0 ? (
            <p className="text-paragraph-xs text-text-sub-600">
              {themes.read === 0
                ? `No replies or transcribed calls in the last ${THEME_WINDOW_DAYS} days yet.`
                : `No theme could be shared without naming someone${themes.withheld ? ` (${themes.withheld} held back)` : ""}. Try again later.`}
            </p>
          ) : (
            <ul className="space-y-1.5" role="radiogroup" aria-label="Themes">
              {themes.themes.map((item) => {
                const selected = theme?.seal === item.seal;
                return (
                  <li key={item.seal}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setTheme(selected ? null : item)}
                      disabled={disabled}
                      className={cn(
                        "w-full rounded-xl px-3 py-2 text-left ring-1 ring-inset transition",
                        selected ? "bg-primary-alpha-10 ring-primary-base" : "bg-bg-white-0 ring-stroke-soft-200 hover:bg-bg-weak-50",
                      )}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-label-sm text-text-strong-950">{item.title}</span>
                        <span className="shrink-0 text-paragraph-xs text-text-soft-400">
                          {THEME_KIND_LABELS[item.kind]} · {item.mentions}×
                        </span>
                      </span>
                      <span className="mt-0.5 block text-paragraph-xs text-text-sub-600">{item.summary}</span>
                    </button>
                  </li>
                );
              })}
              <li className="text-paragraph-xs text-text-soft-400">
                From {themes.read} message{themes.read === 1 ? "" : "s"} and calls{themes.withheld ? `; ${themes.withheld} theme${themes.withheld === 1 ? "" : "s"} held back for naming someone` : ""}.
              </li>
            </ul>
          )}
          {(theme || themeOfSource(currentSource)) && (
            <p className="mt-1.5 flex gap-1.5 text-paragraph-xs text-text-sub-600">
              <RiShieldCheckLine className="mt-px size-3.5 shrink-0" />
              Drafts from a theme are checked for anyone&apos;s name, company, email or phone from those conversations, here and again before the post goes out.
            </p>
          )}
        </div>

        <Button.Root variant="primary" mode="lighter" size="small" onClick={() => run("draft")} disabled={!canDraft}>
          <Button.Icon as={busy === "draft" ? RiLoader4Line : RiMagicLine} className={cn(busy === "draft" && "animate-spin")} />
          {busy === "draft" ? "Writing…" : `Write ${POST_DRAFT_VARIANTS} drafts`}
        </Button.Root>

        <div className="border-t border-stroke-soft-200 pt-4">
          <label className="mb-1.5 block text-label-sm text-text-strong-950" htmlFor="post-rewrite">
            Rewrite what is in the editor
          </label>
          <div className="flex gap-2">
            <Input.Root size="small" className="min-w-0 flex-1">
              <Input.Wrapper>
                <Input.Input
                  id="post-rewrite"
                  value={instruction}
                  maxLength={MAX_REWRITE_INSTRUCTION_LENGTH}
                  onChange={(event) => setInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canRewrite) run("rewrite");
                  }}
                  placeholder="How should it change?"
                  disabled={disabled}
                />
              </Input.Wrapper>
            </Input.Root>
            <Button.Root variant="neutral" mode="stroke" size="small" onClick={() => run("rewrite")} disabled={!canRewrite}>
              <Button.Icon as={busy === "rewrite" ? RiLoader4Line : RiQuillPenLine} className={cn(busy === "rewrite" && "animate-spin")} />
              Rewrite
            </Button.Root>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {REWRITE_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setInstruction(suggestion.toLowerCase())}
                disabled={disabled}
                className="rounded-full bg-bg-weak-50 px-2.5 py-1 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 hover:text-text-strong-950"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p role="alert" className="flex gap-2 rounded-xl bg-error-lighter px-3 py-2.5 text-paragraph-xs text-error-dark">
            <RiErrorWarningLine className="mt-px size-4 shrink-0" />
            {error}
          </p>
        )}

        {answer && (
          <div className="space-y-2">
            <p className="text-paragraph-xs text-text-sub-600">{voiceNote(answer.response, authorName)} Read it before you post: the AI can still get things wrong.</p>
            {withheldNote(answer.response) && (
              <p className="flex gap-1.5 rounded-xl bg-warning-lighter px-3 py-2 text-paragraph-xs text-warning-dark">
                <RiErrorWarningLine className="mt-px size-3.5 shrink-0" />
                {withheldNote(answer.response)}
              </p>
            )}
            <ul className="space-y-2">
              {answer.response.variants.map((variant, index) => (
                <li key={index} className="rounded-xl bg-bg-weak-50 p-3 ring-1 ring-inset ring-stroke-soft-200">
                  <p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-paragraph-sm text-text-strong-950">{variant.body}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-paragraph-xs text-text-soft-400">{variant.body.length.toLocaleString()} characters</span>
                    <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => onUse(variant, answer.response, answer.kind)} disabled={disabled}>
                      Use this
                    </Button.Root>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </FramePanel>
    </Frame>
  );
}
