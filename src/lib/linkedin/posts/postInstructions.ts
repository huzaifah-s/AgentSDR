/**
 * The organization's LinkedIn content brief (docs/linkedin-content/plan.md,
 * Phase 5): how it wants to show up on LinkedIn — who it talks to, what it
 * posts about, how it sounds, what it never posts and its call to action —
 * edited as titled blocks on Settings → Instructions → LinkedIn posts
 * (crm_settings.post_instructions). Null there means these defaults, so an
 * organization that never opens the tab gets them.
 *
 * Facts about the business are not here: they stay in Knowledge, where
 * replies and calls read them too, and only documents tagged `public` reach
 * a post. The brief reaches the post prompts as `{{postInstructions}}`; the
 * author's own voice and the notes on one draft come after it, and its
 * "What we never post" always wins (see the linkedin/post-system prompt).
 *
 * Client-safe and import-free apart from the block type, so the settings page
 * shows the same defaults.
 */
import type { AiInstructionBlock } from "@/lib/crm/ai/instructions";

/** The id of the default "What we never post" block; an organization's own copy keeps it when edited. */
export const NEVER_POST_BLOCK_ID = "never-post";

export const DEFAULT_POST_INSTRUCTIONS: AiInstructionBlock[] = [
  {
    id: "audience",
    title: "Who we're talking to",
    content: [
      "- The buyers our Knowledge describes: their roles, industries and company sizes, and what they care about.",
      "- Write for them, not for other salespeople or marketers. A post is worth reading when it helps them see their own problem more clearly.",
    ].join("\n"),
  },
  {
    id: "pillars",
    title: "What we post about",
    content: [
      "- The problems our customers have before they find us, and what changes after.",
      "- Lessons from the work itself: what we tried, what did not work, what we do now.",
      "- Questions prospects keep asking, answered plainly.",
      "Replace these with your own 3–5 content pillars.",
    ].join("\n"),
  },
  {
    id: "tone",
    title: "How we sound",
    content: [
      "- Plain, specific and calm. Everyday words; short paragraphs.",
      "- Confident without hype: no \"game-changer\", \"revolutionary\", \"unlock\", \"10x\" or \"in today's fast-paced world\".",
      "- One idea per post.",
    ].join("\n"),
  },
  {
    id: NEVER_POST_BLOCK_ID,
    title: "What we never post",
    content: [
      "- Prices, discounts, quotes or anything from a pricing document.",
      "- Competitors by name.",
      "- Customers or clients by name, unless the Knowledge says they may be named publicly.",
      "- Results, numbers or claims the Knowledge does not contain.",
      "- Anything a prospect said, as a quote or in a way that could identify them.",
    ].join("\n"),
  },
  {
    id: "cta",
    title: "Our call to action",
    content: "Usually none: the post itself is the point. When one fits, a low-key invitation to message the author, never a hard sell or a booking link.",
  },
];

/** Hints for the blocks of a person's own writing voice (Settings → LinkedIn accounts → Writing voice). */
export const VOICE_BLOCK_HINTS: readonly { id: string; title: string; placeholder: string }[] = [
  { id: "sound", title: "How I sound", placeholder: "Casual or formal, sentence length, humour. E.g. \"Short, direct sentences. Dry humour now and then.\"" },
  { id: "format", title: "Format", placeholder: "Length, line breaks, emoji, hashtags, lists. E.g. \"Under 150 words. A line break after every sentence. No emoji.\"" },
  { id: "language", title: "Language", placeholder: "Which language, US or UK spelling. E.g. \"English, UK spelling.\"" },
  { id: "phrases", title: "Phrases I use / never use", placeholder: "E.g. \"I say 'folks', never 'guys'. Never 'synergy'.\"" },
  { id: "topics", title: "What I talk about", placeholder: "E.g. \"Hiring SDRs, what I learn from calls, running a small team.\"" },
];

/** Example posts a person may paste for their voice. */
export const MAX_VOICE_EXAMPLES = 5;
