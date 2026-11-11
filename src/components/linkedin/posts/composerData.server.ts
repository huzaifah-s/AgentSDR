import "server-only";

import { channelRules } from "@/lib/channels/rules.server";
import { listPostKnowledge, openRouterProblem } from "@/lib/linkedin/posts/ai.server";
import { listPostAccounts } from "@/lib/linkedin/posts/posts.server";
import { publishedTodayByAccount } from "@/lib/linkedin/posts/publish";
import { PLATFORM_SETTINGS_LABEL } from "@/lib/platform/catalog";
import { isPlatformConnected } from "@/lib/platform/credentials";

/** What the composer needs besides the post, in the organization in scope. */
export async function loadComposerData() {
  const [accounts, r2Connected, { postsPerDay }, publishedToday, aiProblem] = await Promise.all([
    listPostAccounts(),
    isPlatformConnected("r2"),
    channelRules("linkedin"),
    publishedTodayByAccount(),
    openRouterProblem(),
  ]);
  // Without OpenRouter the composer has no AI panel, so its Knowledge is not read either.
  const knowledge = aiProblem ? [] : await listPostKnowledge();
  return { accounts, r2Connected, r2SettingsLabel: PLATFORM_SETTINGS_LABEL.r2, postsPerDay, publishedToday, aiReady: !aiProblem, knowledge };
}
