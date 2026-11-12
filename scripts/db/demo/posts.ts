/**
 * Northwind on LinkedIn, as its people post there from AgentSDR: published
 * posts from the last six weeks, a few scheduled for the coming days, drafts
 * (written by hand, from a topic with AI, from Knowledge), one that failed,
 * the organization's content brief (Settings → Instructions → LinkedIn
 * posts) and Alex's and Priya's writing voices.
 *
 * Posts carry no images: their attachments live in R2, which the demo does
 * not have. Nothing here publishes; post URLs point nowhere real.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmSettings } from "@/lib/crm/schema";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { linkedinAuthorVoices, linkedinPosts } from "@/lib/linkedin/posts/schema";
import { MISSED_TIME_ERROR, SYSTEM_PUBLISHER, type LinkedinPostSource } from "@/lib/linkedin/posts/contract";
import { DEFAULT_POST_INSTRUCTIONS, NEVER_POST_BLOCK_ID } from "@/lib/linkedin/posts/postInstructions";
import { inOrg } from "@/lib/tenancy/scope";
import { TEAM, type TeamKey } from "./content";
import { DAY, HOUR, MINUTE, count, createRng, daysAgo, type DemoContext } from "./context";

const MODEL = "anthropic/claude-sonnet-4.5";
const DRAFT_PROMPTS = [
  { name: "linkedin/post-system", version: null },
  { name: "linkedin/post-user", version: null },
];

type PostDef = {
  author: TeamKey;
  status: "published" | "scheduled" | "draft" | "failed";
  /** Published / failed: days ago. Scheduled: days ahead. Draft: days since last edit. */
  days: number;
  /** UTC hour it went (or goes) out. */
  hour: number;
  source: LinkedinPostSource | null;
  ai?: boolean;
  /** Scheduled by the author and published by the job (published posts only). */
  viaSchedule?: boolean;
  error?: string;
  body: string;
};

const POSTS: PostDef[] = [
  // ------------------------------------------------------------------ published
  {
    author: "alex", status: "published", days: 41, hour: 14, source: { kind: "blank" },
    body: `Our reps used to spend Monday morning in spreadsheets.

Not prospecting. Deciding who to prospect.

Twelve people, each with their own list, each with their own idea of a "good fit". The result was a busy Monday and a quiet Tuesday.

What fixed it was boring: one written definition of a good account, scored the same way for everyone, refreshed every week.

The hard part was not the scoring. It was agreeing on the definition.`,
  },
  {
    author: "priya", status: "published", days: 36, hour: 15, source: { kind: "topic", topic: "What I look for when hiring SDRs" }, ai: true,
    body: `I have hired eleven SDRs. The best ones had one thing in common, and it was not experience.

They asked a second question.

"How do you handle that today?" is a first question. Anyone can learn it.
"What happens when that goes wrong?" is the second one. That is where the real conversation starts.

In interviews I now role-play a short discovery call and count the follow-ups. It predicts more than any CV I have read.`,
  },
  {
    author: "alex", status: "published", days: 30, hour: 13, source: { kind: "knowledge", knowledgeDocumentIds: [] }, ai: true, viaSchedule: true,
    body: `A customer of ours went from 38 first meetings a month to 81 in one quarter.

Same six SDRs. Same sequencer. Same market.

What changed was the list. Instead of 2,000 accounts "worth a try", each rep started the week with about 70 accounts, and a sentence on why each one was on it.

Fewer accounts, better reasons. That was the whole trick.

(Brightloop let us share this. Thank you, team.)`,
  },
  {
    author: "sam", status: "published", days: 26, hour: 9, source: { kind: "blank" },
    body: `Three months as an SDR. Things nobody told me:

1. Most "no"s are "not now". Write down when to come back.
2. The best opener is the reason you picked them. If you cannot say it in one line, pick someone else.
3. Voicemails work better when they are twelve seconds long.
4. Your calendar is your scoreboard. Activity is not.

What would you add?`,
  },
  {
    author: "alex", status: "published", days: 21, hour: 15, source: { kind: "topic", topic: "Why we stopped measuring activity" }, ai: true, viaSchedule: true,
    body: `We stopped putting call counts on the team dashboard.

Not because activity does not matter. Because it was the only number everyone could move on their own, so everyone moved it.

Now the dashboard shows three things: accounts worked this week, conversations, and meetings that actually happened.

Calls went down a little. Meetings went up. Nobody misses the old board.`,
  },
  {
    author: "priya", status: "published", days: 14, hour: 14, source: { kind: "blank" }, viaSchedule: true,
    body: `A question I get from new SDRs: "How many times should I follow up?"

My answer: until you have something new to say, and not once more.

A follow-up that only says "bumping this" teaches the reader that your emails can be skipped. A follow-up with a new reason, a new person or a new piece of proof earns the next one.`,
  },
  {
    author: "alex", status: "published", days: 9, hour: 13, source: { kind: "topic", topic: "Answer the questions prospects keep asking" }, ai: true,
    body: `The question prospects ask us most is not about price or features.

It is: "Does this replace the tool we already have?"

Almost never. Most teams already have a way to send. What they are missing is a reliable way to decide who to send to, and why now.

If your buyers keep asking the same question, it belongs in your first message, not your third call.`,
  },
  {
    author: "priya", status: "published", days: 4, hour: 15, source: { kind: "blank" },
    body: `We tried AI phone calls for the first touch this month. Some notes, honestly.

The agent says it is an AI in the first sentence. People are more patient with that than I expected.

What it is good at: reaching people at the right hour, sending the booking link straight after, never forgetting a call-back.

What it is not: a closer. When someone wants to talk details, it hands over to a person, and that is exactly the point.`,
  },

  // ------------------------------------------------------------------ scheduled
  {
    author: "alex", status: "scheduled", days: 1, hour: 14, source: { kind: "topic", topic: "The one-line reason test for outbound lists" }, ai: true,
    body: `Before an account goes on our outbound list, it has to pass one test:

Can you say in one line why this company, and why now?

"They are hiring four SDRs." Yes.
"They just moved to HubSpot." Yes.
"They are in our industry." Not a reason.

Accounts that fail the test do not get worse emails. They get no email at all, and the rest get our full attention.`,
  },
  {
    author: "priya", status: "scheduled", days: 3, hour: 15, source: { kind: "blank" },
    body: `Coaching note I gave three times this week, so it might help someone else:

Do not end a discovery call with "Does that sound interesting?"

End it with the next step, already proposed: "Shall we look at your accounts together on Thursday at 11?"

People rarely say yes to "interesting". They often say yes to Thursday.`,
  },
  {
    author: "sam", status: "scheduled", days: 6, hour: 9, source: { kind: "topic", topic: "What I learned from my first 500 cold calls" }, ai: true,
    body: `I have made about 500 cold calls since joining Northwind. The pattern that surprised me most:

The first ten seconds decide everything, and the best ten seconds are a question about them, not a sentence about us.

"Is Monday still research day for your team?" gets a laugh and a real answer far more often than any pitch I have tried.`,
  },

  // ------------------------------------------------------------------ drafts
  {
    author: "alex", status: "draft", days: 0, hour: 0, source: { kind: "topic", topic: "Why we publish our ICP definition internally" }, ai: true,
    body: `Every new hire at Northwind reads the same one-page document in their first week: what a good account looks like for us.

It is not a secret and it is not complicated. It changes every quarter, and the change log is the most useful part.

[Add the example from the Q3 change: when we dropped company size as a hard rule]`,
  },
  {
    author: "priya", status: "draft", days: 1, hour: 0, source: { kind: "blank" },
    body: `Things I wish every sales leader measured:

- Time from sign-up to first conversation
- Meetings held, not booked
- `,
  },
  {
    author: "alex", status: "draft", days: 2, hour: 0, source: { kind: "knowledge", knowledgeDocumentIds: [] }, ai: true,
    body: `Security reviews do not have to take months.

When a prospect asks for our SOC 2 report, they get it the same day, with our DPA and a one-page summary of how data is kept separate for each customer.

Most reviews finish in about two weeks that way. The slow ones are almost always the ones where the documents arrived late.`,
  },
  {
    author: "sam", status: "draft", days: 0, hour: 0, source: null,
    body: "",
  },

  // ------------------------------------------------------------------ failed
  {
    author: "priya", status: "failed", days: 2, hour: 13, source: { kind: "blank" },
    error: `${MISSED_TIME_ERROR}: the LinkedIn account was reconnecting when it was due, and it was more than 6 hours late by then. Pick a new time to schedule it again.`,
    body: `The best sales meeting I had last month started with: "Before we begin, here's what I already know about you, tell me what I got wrong."

Five minutes later we were talking about their real problem.`,
  },
];

/** Northwind's content brief: the defaults' shape (and the never-post block's id), in its own words. */
const BRIEF = DEFAULT_POST_INSTRUCTIONS.map((block) => {
  switch (block.id) {
    case "audience":
      return { ...block, content: "- Heads of sales, sales ops and RevOps at B2B companies with 50–1,000 employees.\n- Founders who still run sales themselves.\n- Write for them, not for other vendors." };
    case "pillars":
      return {
        ...block,
        content: "- Deciding who to contact: ICPs, account scoring, lists that stay small.\n- Running an SDR team: hiring, coaching, what to measure.\n- What we learn from our own outbound, including what did not work.\n- Answers to the questions prospects keep asking.",
      };
    case "tone":
      return { ...block, content: "- Plain, specific and calm. Short paragraphs, one idea per post.\n- First person, from the author's own work.\n- No hype words, no emoji walls, at most two hashtags." };
    case NEVER_POST_BLOCK_ID:
      return { ...block, content: `${block.content}\n- Anything about a deal that is still open.` };
    case "cta":
      return { ...block, content: "Usually none. When one fits, invite people to message the author. Never a booking link or a discount." };
    default:
      return block;
  }
});

const VOICES: Partial<Record<TeamKey, { blocks: { id: string; title: string; content: string }[]; examples: number[] }>> = {
  alex: {
    blocks: [
      { id: "sound", title: "How I sound", content: "Short, direct sentences. A bit dry. I say what we did and what happened, then stop." },
      { id: "format", title: "Format", content: "Under 150 words. A line break between short paragraphs. No emoji, no hashtags." },
      { id: "language", title: "Language", content: "English, US spelling." },
      { id: "phrases", title: "Phrases I use / never use", content: "I say \"the team\", never \"my team\". Never \"game-changer\", \"crushing it\" or \"let that sink in\"." },
      { id: "topics", title: "What I talk about", content: "Running a sales team, what we measure, how we decide who to contact." },
    ],
    examples: [0, 4],
  },
  priya: {
    blocks: [
      { id: "sound", title: "How I sound", content: "Warm and practical, like a coaching note to one person. Honest about what did not work." },
      { id: "format", title: "Format", content: "100–180 words. Often a question from the team as the first line. No emoji." },
      { id: "topics", title: "What I talk about", content: "Hiring and coaching SDRs, follow-ups, discovery calls, trying new tools on the team." },
    ],
    examples: [1, 5],
  },
};

export async function seedPosts(shared: DemoContext): Promise<void> {
  const ctx: DemoContext = { ...shared, rand: createRng(57) };
  const { rand, now } = ctx;
  const org = ctx.organizationId;

  const accounts = await db
    .select({ id: linkedInAccounts.id, name: linkedInAccounts.name })
    .from(linkedInAccounts)
    .where(inOrg(linkedInAccounts));
  const accountOf = (key: TeamKey) => accounts.find((a) => a.name === TEAM[key].name)?.id;

  // Knowledge every post may draw on.
  const knowledge = (await db.execute<{ id: string; title: string }>(sql`
    select id, title from crm_knowledge_documents where organization_id = ${org} and 'public' = any(tags)`)) as unknown as { id: string; title: string }[];

  // LinkedIn activity ids are 19 digits; built as text, past Number's exact range.
  let activity = rand.int(100_000_000, 900_000_000);
  const rows: (typeof linkedinPosts.$inferInsert)[] = [];
  for (const post of POSTS) {
    const account = accountOf(post.author);
    if (!account) continue;
    const user = ctx.users[post.author].id;
    /** That day at the post's hour, moved off the weekend (back for past posts, forward for scheduled ones). */
    const at = (d: Date) => {
      const x = new Date(d);
      const step = post.status === "scheduled" ? 1 : -1;
      while (x.getUTCDay() === 0 || x.getUTCDay() === 6) x.setUTCDate(x.getUTCDate() + step);
      x.setUTCHours(post.hour, rand.int(0, 3) * 15, 0, 0);
      return x;
    };
    const source: LinkedinPostSource | null =
      post.source?.kind === "knowledge" ? { kind: "knowledge", knowledgeDocumentIds: knowledge.map((k) => k.id) } : post.source;
    const generation = post.ai ? { model: MODEL, prompts: DRAFT_PROMPTS } : null;
    const base = { organizationId: org, linkedinAccountId: account, body: post.body, source, generation, createdBy: user };

    if (post.status === "published") {
      const publishedAt = at(daysAgo(ctx, post.days));
      const createdAt = new Date(publishedAt.getTime() - rand.int(post.viaSchedule ? 30 : 1, post.viaSchedule ? 100 : 8) * HOUR);
      activity += rand.int(1_000_000, 9_000_000);
      rows.push({
        ...base,
        status: "published",
        scheduledAt: post.viaSchedule ? publishedAt : null,
        publishedAt,
        providerPostId: `urn:li:activity:73910${String(activity).padStart(14, "0")}`,
        postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:73910${String(activity).padStart(14, "0")}/`,
        publishedBy: post.viaSchedule ? SYSTEM_PUBLISHER : user,
        createdAt,
        updatedAt: new Date(publishedAt.getTime() + 5000),
      });
    } else if (post.status === "scheduled") {
      const scheduledAt = at(new Date(now.getTime() + post.days * DAY));
      const createdAt = new Date(now.getTime() - rand.int(3, 40) * HOUR);
      rows.push({ ...base, status: "scheduled", scheduledAt, createdAt, updatedAt: new Date(createdAt.getTime() + rand.int(5, 60) * MINUTE) });
    } else if (post.status === "failed") {
      const scheduledAt = at(daysAgo(ctx, post.days));
      rows.push({
        ...base,
        status: "failed",
        scheduledAt,
        error: post.error ?? null,
        createdAt: new Date(scheduledAt.getTime() - 2 * DAY),
        updatedAt: new Date(scheduledAt.getTime() + 6 * HOUR + 5 * MINUTE),
      });
    } else {
      const updatedAt = new Date(now.getTime() - post.days * DAY - rand.int(20, 300) * MINUTE);
      rows.push({ ...base, status: "draft", createdAt: new Date(updatedAt.getTime() - rand.int(10, 120) * MINUTE), updatedAt });
    }
  }
  await db.insert(linkedinPosts).values(rows);
  count(ctx, "LinkedIn posts", rows.length);

  // Writing voices, with their own published posts as examples.
  let voices = 0;
  for (const [key, voice] of Object.entries(VOICES) as [TeamKey, NonNullable<(typeof VOICES)[TeamKey]>][]) {
    const account = accountOf(key);
    if (!account) continue;
    const at = daysAgo(ctx, 12 + voices * 5);
    await db.insert(linkedinAuthorVoices).values({
      organizationId: org,
      linkedinAccountId: account,
      instructions: voice.blocks,
      examplePosts: voice.examples.map((i) => POSTS[i]!.body),
      updatedBy: TEAM[key].email,
      createdAt: at,
      updatedAt: at,
    });
    voices++;
  }
  count(ctx, "LinkedIn writing voices", voices);

  // The content brief.
  await db.update(crmSettings).set({ postInstructions: BRIEF }).where(eq(crmSettings.pipelineId, ctx.pipelineId));
}
