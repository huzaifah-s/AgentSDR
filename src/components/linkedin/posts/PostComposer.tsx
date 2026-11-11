"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RiCloseLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiImageAddLine,
  RiLoader4Line,
  RiSave3Line,
  RiSendPlaneLine,
} from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Select from "@/components/alignui/select";
import * as Textarea from "@/components/alignui/textarea";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useDialogs } from "@/components/DialogProvider";
import { LinkedInAccountTag } from "@/components/linkedin/LinkedInAccountTag";
import { PageHeader } from "@/components/page/PageHeader";
import {
  EDITABLE_STATUSES,
  feedPreview,
  MAX_POST_IMAGE_BYTES,
  MAX_POST_IMAGES,
  MAX_POST_LENGTH,
  POST_IMAGE_TYPES,
  UNCERTAIN_PUBLISH_ERROR,
  type LinkedinPostAccount,
  type LinkedinPostView,
} from "@/lib/linkedin/posts/contract";
import { cn } from "@/utils/cn";

/** Unipile's limit on an image's sides. Checked here, where the image can be measured. */
const MAX_IMAGE_SIDE = 6012;

type Props = {
  post: LinkedinPostView | null;
  accounts: LinkedinPostAccount[];
  r2Connected: boolean;
  r2SettingsLabel: string;
  postsPerDay: number;
  publishedToday: Record<string, number>;
};

const accountName = (account: LinkedinPostAccount | null | undefined) => account?.name || account?.username || "this account";

async function api<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data as T;
}

function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

export function PostComposer({ post: initial, accounts, r2Connected, r2SettingsLabel, postsPerDay, publishedToday }: Props) {
  const router = useRouter();
  const dialogs = useDialogs();
  const fileInput = useRef<HTMLInputElement>(null);

  const [post, setPost] = useState<LinkedinPostView | null>(initial);
  const [accountId, setAccountId] = useState(initial?.account?.id ?? accounts.find((a) => a.status === "CONNECTED")?.id ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [busy, setBusy] = useState<"save" | "publish" | "image" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const readOnly = post ? !EDITABLE_STATUSES.includes(post.status) : false;
  const dirty = !post || body !== post.body || accountId !== (post.account?.id ?? "");
  const account = accounts.find((a) => a.id === accountId) ?? post?.account ?? null;
  const today = account ? publishedToday[account.id] ?? 0 : 0;
  const atLimit = today >= postsPerDay;
  const tooLong = body.length > MAX_POST_LENGTH;
  const preview = feedPreview(body);
  const uncertain = post?.status === "failed" && post.error?.startsWith(UNCERTAIN_PUBLISH_ERROR);

  /** Save what is on screen (creating the draft first time) and return the saved post. */
  async function save(): Promise<LinkedinPostView> {
    if (!accountId) throw new Error("Choose a LinkedIn account");
    if (!post) {
      const { post: created } = await api<{ post: LinkedinPostView }>("/api/linkedin/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedinAccountId: accountId, body }),
      });
      setPost(created);
      window.history.replaceState(null, "", `/linkedin/posts/${created.id}`);
      return created;
    }
    // A failed post always goes back through PATCH, which makes it a draft again.
    if (!dirty && post.status !== "failed") return post;
    const { post: saved } = await api<{ post: LinkedinPostView }>(`/api/linkedin/posts/${post.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkedinAccountId: accountId, body }),
    });
    setPost(saved);
    return saved;
  }

  async function run(kind: NonNullable<typeof busy>, fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const onSave = () =>
    run("save", async () => {
      await save();
      setNotice("Draft saved.");
      router.refresh();
    });

  const onPublish = async () => {
    if (!account) return setError("Choose a LinkedIn account");
    const ok = await dialogs.confirm({
      title: "Publish this post now?",
      description: (
        <>
          This posts publicly on {accountName(account)}&apos;s LinkedIn.
          {uncertain && " The last attempt may have gone out: check their profile first so it is not posted twice."}
        </>
      ),
      confirmLabel: "Publish now",
    });
    if (!ok) return;
    await run("publish", async () => {
      const saved = await save();
      const { outcome, post: after } = await api<{ outcome: { status: "published" | "failed"; error?: string }; post: LinkedinPostView }>(
        `/api/linkedin/posts/${saved.id}/publish`,
        { method: "POST" },
      );
      setPost(after);
      setBody(after.body);
      if (outcome.status === "failed") setError(outcome.error ?? "The post could not be published.");
      else setNotice("Published.");
      router.refresh();
    });
  };

  const onDelete = async () => {
    if (!post) return router.push("/linkedin/posts");
    const ok = await dialogs.confirm({
      title: "Delete this post?",
      description: "The post and its images are deleted. This cannot be undone.",
      confirmLabel: "Delete post",
      variant: "error",
    });
    if (!ok) return;
    await run("delete", async () => {
      await api(`/api/linkedin/posts/${post.id}`, { method: "DELETE" });
      router.push("/linkedin/posts");
      router.refresh();
    });
  };

  const onPickImage = async (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = "";
    if (!file) return;
    await run("image", async () => {
      if (!POST_IMAGE_TYPES[file.type]) throw new Error("Use a JPG, PNG, WebP or GIF image.");
      if (file.size > MAX_POST_IMAGE_BYTES) throw new Error(`An image can be at most ${MAX_POST_IMAGE_BYTES / (1024 * 1024)} MB.`);
      const size = await imageSize(file);
      if (size && (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE)) {
        throw new Error(`LinkedIn takes images up to ${MAX_IMAGE_SIDE}×${MAX_IMAGE_SIDE} pixels; this one is ${size.width}×${size.height}.`);
      }
      const saved = await save();
      const form = new FormData();
      form.append("file", file);
      const { post: after } = await api<{ post: LinkedinPostView }>(`/api/linkedin/posts/${saved.id}/images`, { method: "POST", body: form });
      setPost(after);
    });
  };

  const onRemoveImage = (imageId: string) =>
    run("image", async () => {
      if (!post) return;
      const { post: after } = await api<{ post: LinkedinPostView }>(`/api/linkedin/posts/${post.id}/images/${imageId}`, { method: "DELETE" });
      setPost(after);
    });

  const images = post?.attachments ?? [];
  const connectedAccounts = accounts.filter((a) => a.status === "CONNECTED");
  const canPublish = !readOnly && !busy && Boolean(account) && account?.status === "CONNECTED" && body.trim().length > 0 && !tooLong && !atLimit;

  return (
    <div className="mx-auto w-full max-w-[1200px]">
      <PageHeader
        back={{ href: "/linkedin/posts", label: "Posts" }}
        title={!post ? "New post" : readOnly ? "Post" : "Edit post"}
        badge={
          post?.status === "published" ? (
            <Badge.Root variant="lighter" color="green" size="small">Published</Badge.Root>
          ) : post?.status === "publishing" ? (
            <Badge.Root variant="lighter" color="blue" size="small">Publishing…</Badge.Root>
          ) : post?.status === "failed" ? (
            <Badge.Root variant="lighter" color="red" size="small">Failed</Badge.Root>
          ) : post ? (
            <Badge.Root variant="lighter" color="gray" size="small">Draft</Badge.Root>
          ) : null
        }
        description={
          post?.createdBy || post?.publishedBy
            ? [post.createdBy && `Written by ${post.createdBy.name ?? "a former member"}`, post.publishedBy && `published by ${post.publishedBy.name ?? "a former member"}`]
                .filter(Boolean)
                .join(", ")
            : "Posts go out on the chosen person's own LinkedIn profile."
        }
        actions={
          readOnly ? (
            post?.postUrl ? (
              <Button.Root variant="neutral" mode="stroke" size="small" asChild>
                <a href={post.postUrl} target="_blank" rel="noreferrer">
                  <Button.Icon as={RiExternalLinkLine} />
                  View on LinkedIn
                </a>
              </Button.Root>
            ) : undefined
          ) : (
            <>
              <Button.Root variant="neutral" mode="ghost" size="small" onClick={onDelete} disabled={Boolean(busy)}>
                <Button.Icon as={busy === "delete" ? RiLoader4Line : RiDeleteBinLine} className={cn(busy === "delete" && "animate-spin")} />
                {post ? "Delete" : "Discard"}
              </Button.Root>
              <Button.Root variant="neutral" mode="stroke" size="small" onClick={onSave} disabled={Boolean(busy) || !accountId || tooLong || (!dirty && post?.status !== "failed")}>
                <Button.Icon as={busy === "save" ? RiLoader4Line : RiSave3Line} className={cn(busy === "save" && "animate-spin")} />
                Save draft
              </Button.Root>
              <Button.Root variant="primary" mode="filled" size="small" onClick={onPublish} disabled={!canPublish}>
                <Button.Icon as={busy === "publish" ? RiLoader4Line : RiSendPlaneLine} className={cn(busy === "publish" && "animate-spin")} />
                Publish now
              </Button.Root>
            </>
          )
        }
      />

      {(error || (post?.status === "failed" && post.error)) && (
        <div role="alert" className="mt-5 flex gap-2 rounded-xl bg-error-lighter px-4 py-3 text-paragraph-sm text-error-dark">
          <RiErrorWarningLine className="mt-0.5 size-4 shrink-0" />
          <div>
            <p>{error ?? post?.error}</p>
            {!error && post?.status === "failed" && (
              <p className="mt-1 text-paragraph-xs">
                {uncertain
                  ? "Look at the profile on LinkedIn. If the post is not there, edit or save it here, then publish again."
                  : "Edit the post or save it as a draft, then publish again."}
              </p>
            )}
          </div>
        </div>
      )}
      {notice && !error && (
        <p role="status" className="mt-5 rounded-xl bg-success-lighter px-4 py-3 text-paragraph-sm text-success-dark">
          {notice}
          {post?.status === "published" && !post.postUrl && " LinkedIn did not return a link; find it on the profile."}
        </p>
      )}

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
        <Frame className="lg:col-span-7">
          <FrameHeader title="Write" description="Plain text, as LinkedIn shows it. Line breaks are kept." />
          <FramePanel className="space-y-4">
            <div>
              <label className="mb-1.5 block text-label-sm text-text-strong-950" htmlFor="post-account">
                Post as
              </label>
              {readOnly ? (
                post?.account ? <LinkedInAccountTag account={post.account} size="md" /> : <span className="text-paragraph-sm text-text-soft-400">Account removed</span>
              ) : accounts.length === 0 ? (
                <p className="text-paragraph-sm text-text-sub-600">
                  No LinkedIn accounts yet. <Link className="text-primary-base hover:underline" href="/settings/linkedin-accounts">Connect one</Link> to post from it.
                </p>
              ) : (
                <Select.Root value={accountId} onValueChange={setAccountId} size="small">
                  <Select.Trigger id="post-account" className="w-full sm:w-80">
                    <Select.Value placeholder="Choose a LinkedIn account" />
                  </Select.Trigger>
                  <Select.Content>
                    {accounts.map((a) => (
                      <Select.Item key={a.id} value={a.id} disabled={a.status !== "CONNECTED"}>
                        {accountName(a)}
                        {a.status !== "CONNECTED" ? " (disconnected)" : ""}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              )}
              {!readOnly && account && (
                <p className={cn("mt-1.5 text-paragraph-xs", atLimit ? "text-warning-base" : "text-text-sub-600")}>
                  {accountName(account)} has published {today} of {postsPerDay} posts allowed today
                  {atLimit ? ". Publish tomorrow, or raise the limit in Settings → LinkedIn → Sending rules." : "."}
                </p>
              )}
              {!readOnly && accounts.length > 0 && connectedAccounts.length === 0 && (
                <p className="mt-1.5 text-paragraph-xs text-warning-base">All of your LinkedIn accounts are disconnected. Reconnect one to publish.</p>
              )}
            </div>

            <div>
              <label className="mb-1.5 block text-label-sm text-text-strong-950" htmlFor="post-body">
                Post
              </label>
              {readOnly ? (
                <p className="whitespace-pre-wrap rounded-xl bg-bg-weak-50 px-3 py-2.5 text-paragraph-sm text-text-strong-950">{post?.body}</p>
              ) : (
                <Textarea.Root
                  id="post-body"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={14}
                  hasError={tooLong}
                  placeholder="What do you want to say? The first lines are what people see before “…see more”."
                  className="min-h-72"
                >
                  <Textarea.CharCounter current={body.length} max={MAX_POST_LENGTH} />
                </Textarea.Root>
              )}
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-label-sm text-text-strong-950">Images</span>
                <span className="text-paragraph-xs text-text-soft-400">
                  {images.length}/{MAX_POST_IMAGES}
                </span>
              </div>
              {images.length > 0 && (
                <ul className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {images.map((image) => (
                    <li key={image.imageId} className="group relative aspect-square overflow-hidden rounded-lg bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200">
                      {/* eslint-disable-next-line @next/next/no-img-element -- a presigned R2 redirect, not a static asset */}
                      <img src={`/api/linkedin/posts/${post!.id}/images/${image.imageId}`} alt={image.fileName} className="size-full object-cover" />
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => onRemoveImage(image.imageId)}
                          disabled={Boolean(busy)}
                          aria-label={`Remove ${image.fileName}`}
                          className="absolute right-1 top-1 rounded-full bg-bg-white-0/90 p-1 text-text-sub-600 shadow-regular-xs hover:text-text-strong-950"
                        >
                          <RiCloseLine className="size-4" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!readOnly &&
                (r2Connected ? (
                  <>
                    <input
                      ref={fileInput}
                      type="file"
                      accept={Object.keys(POST_IMAGE_TYPES).join(",")}
                      className="sr-only"
                      onChange={(event) => onPickImage(event.target.files?.[0])}
                    />
                    <Button.Root
                      variant="neutral"
                      mode="stroke"
                      size="xsmall"
                      onClick={() => fileInput.current?.click()}
                      disabled={Boolean(busy) || images.length >= MAX_POST_IMAGES || !accountId}
                    >
                      <Button.Icon as={busy === "image" ? RiLoader4Line : RiImageAddLine} className={cn(busy === "image" && "animate-spin")} />
                      Add image
                    </Button.Root>
                    <p className="mt-1.5 text-paragraph-xs text-text-soft-400">JPG, PNG, WebP or GIF, up to {MAX_POST_IMAGE_BYTES / (1024 * 1024)} MB each.</p>
                  </>
                ) : (
                  <p className="text-paragraph-xs text-text-sub-600">
                    Posts are text only until Cloudflare R2 is connected ({r2SettingsLabel}): images are stored there until they are published.
                  </p>
                ))}
            </div>
          </FramePanel>
        </Frame>

        <Frame className="lg:col-span-5">
          <FrameHeader title="Preview" description="Roughly what the feed shows before “…see more”. LinkedIn's exact cut varies by screen." />
          <FramePanel>
            <article className="rounded-xl bg-bg-white-0 p-4 ring-1 ring-inset ring-stroke-soft-200">
              {account ? <LinkedInAccountTag account={account} size="md" /> : <span className="text-paragraph-xs text-text-soft-400">Choose an account</span>}
              <p className={cn("mt-3 whitespace-pre-wrap break-words text-paragraph-sm", body.trim() ? "text-text-strong-950" : "text-text-soft-400")}>
                {body.trim() ? preview.shown : "Your post's first lines show here."}
                {preview.truncated && <span className="text-text-sub-600">… see more</span>}
              </p>
              {images.length > 0 && (
                <div className={cn("mt-3 grid gap-1", images.length > 1 && "grid-cols-2")}>
                  {images.map((image) => (
                    // eslint-disable-next-line @next/next/no-img-element -- a presigned R2 redirect, not a static asset
                    <img key={image.imageId} src={`/api/linkedin/posts/${post!.id}/images/${image.imageId}`} alt="" className="aspect-square w-full rounded-md object-cover" />
                  ))}
                </div>
              )}
            </article>
          </FramePanel>
        </Frame>
      </div>
    </div>
  );
}
