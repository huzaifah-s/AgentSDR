import "server-only";

import { channelRules } from "@/lib/channels/rules.server";
import { listPostKnowledge, openRouterProblem } from "@/lib/linkedin/posts/ai.server";
import { listPostAccounts, postTimesByAccount } from "@/lib/linkedin/posts/posts.server";
import { voiceLine } from "@/lib/linkedin/posts/contract";
import { publishedTodayByAccount } from "@/lib/linkedin/posts/publish";
import { listAuthorVoices } from "@/lib/linkedin/posts/voices.server";
import { PLATFORM_SETTINGS_LABEL } from "@/lib/platform/catalog";
import { isPlatformConnected } from "@/lib/platform/credentials";

/** What the composer needs besides the post, in the organization in scope. */
export async function loadComposerData() {
  const [accounts, r2Connected, { postsPerDay }, { timeZone }, publishedToday, postTimes, aiProblem, voices] = await Promise.all([
    listPostAccounts(),
    isPlatformConnected("r2"),
    channelRules("linkedin"),
    channelRules("general"),
    publishedTodayByAccount(),
    postTimesByAccount(),
    openRouterProblem(),
    listAuthorVoices(),
  ]);
  const voiceLines: Record<string, string> = {};
  for (const [accountId, voice] of Object.entries(voices)) {
    const line = voiceLine(voice);
    if (line) voiceLines[accountId] = line;
  }
  // Without OpenRouter the composer has no AI panel, so its Knowledge is not read either.
  const knowledge = aiProblem ? [] : await listPostKnowledge();
  return { accounts, r2Connected, r2SettingsLabel: PLATFORM_SETTINGS_LABEL.r2, postsPerDay, publishedToday, timeZone, postTimes, aiReady: !aiProblem, knowledge, voiceLines };
}
