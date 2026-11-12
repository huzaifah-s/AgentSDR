/**
 * Fills a FRESH database with Northwind, a fictional company, and three
 * months of its sales team's work across every part of AgentSDR: the lead
 * database, email, LinkedIn and WhatsApp campaigns, calls with transcripts,
 * the CRM pipeline with AI drafts waiting for review, Tables and Analytics.
 * It is what the public demo (DEMO_MODE, src/lib/demo/mode.ts) shows, what a
 * contributor gets to click around in, and where screenshots are taken.
 *
 *   bun --conditions=react-server scripts/db/seed-demo.ts [--allow-remote]
 *
 * Run `bun run db:setup` first. Safe to re-run: if the demo organization
 * exists it says so and exits 0 without touching anything.
 *
 * Refuses to run when NODE_ENV=production, or when DATABASE_URL is not on
 * localhost / 127.0.0.1 (pass --allow-remote to override the latter) —
 * unless DEMO_MODE=true says this database belongs to a demo deployment.
 *
 * The pieces live in scripts/db/demo/: content.ts (the fictional world),
 * context.ts (shared clock and randomness), then one module per area. Data
 * is written through the application's own lib functions where one fits,
 * with direct inserts for history those functions would stamp "now".
 * Every timestamp is relative to the moment the seed runs; the demo's daily
 * clock (src/lib/demo/clock.ts) keeps it current afterwards.
 */

import { DEMO_DEFAULT_PASSWORD, DEMO_USER_EMAIL } from "@/lib/demo/mode";
import { ORG_NAME, ORG_SLUG, TEAM } from "./demo/content";
import { createRng, type DemoContext } from "./demo/context";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || DEMO_DEFAULT_PASSWORD;

/** Returns true when DEMO_MODE is what lets the seed write to a non-local database. */
function guard(): boolean {
  const demoDeployment = ["1", "true", "yes", "on"].includes((process.env.DEMO_MODE ?? "").trim().toLowerCase());
  if (process.env.NODE_ENV === "production" && !demoDeployment) {
    console.error("Refusing to seed demo data: NODE_ENV=production.");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set — copy .env.example to .env.local and fill it in.");
    process.exit(1);
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    console.error("DATABASE_URL is not a valid URL.");
    process.exit(1);
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!local && !demoDeployment && !process.argv.includes("--allow-remote")) {
    console.error(
      `Refusing to seed demo data into "${host}": it is not localhost/127.0.0.1. ` +
        "Demo data is fictional and should never land in a real database. Pass --allow-remote if you are sure.",
    );
    process.exit(1);
  }
  console.log(`Seeding the database on ${host}.`);
  return !local && demoDeployment && !process.argv.includes("--allow-remote");
}

async function main() {
  const viaDemoMode = guard();

  const { db } = await import("@/lib/db");
  const { auth } = await import("@/lib/auth/server");
  const { organizations, users } = await import("@/lib/auth/schema");
  const { eq, sql } = await import("drizzle-orm");

  // DEMO_MODE only vouches for a demo deployment's own database. If this one
  // holds any real organization, DATABASE_URL is pointing somewhere else —
  // e.g. a production URL picked up from .env.local — so stop.
  if (viaDemoMode) {
    const [{ real }] = (await db.execute(sql`
      select count(*)::int as real from organizations
       where metadata is null or (metadata::jsonb ->> 'demo') is distinct from 'true'`)) as unknown as { real: number }[];
    if (real > 0) {
      console.error(
        `Refusing to seed: this database already holds ${real} real organization${real === 1 ? "" : "s"}. ` +
          "A demo deployment's database holds nothing but the demo. Check DATABASE_URL.",
      );
      process.exit(1);
    }
  }

  const [existingOrg] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, ORG_SLUG)).limit(1);
  if (existingOrg) {
    console.log(`The demo organization "${ORG_NAME}" already exists (${existingOrg.id}); nothing to do.`);
    console.log(`Sign in as ${DEMO_USER_EMAIL} (the password you set the first time).`);
    process.exit(0);
  }

  // 1. The demo user + organization through Better Auth. Sign-up is
  // invite-only by default, which would refuse the demo user on a database
  // that already has an account. This process is a seed, not a visitor, so
  // it opens sign-up for itself only; the policy is read per call.
  process.env.AUTH_SIGNUP = "open";
  let [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_USER_EMAIL)).limit(1);
  if (!owner) {
    await auth.api.signUpEmail({ body: { name: TEAM.alex.name, email: DEMO_USER_EMAIL, password: DEMO_PASSWORD } });
    [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_USER_EMAIL)).limit(1);
  }
  if (!owner) throw new Error("Better Auth did not create the demo user");
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, owner.id));
  const now = new Date();
  const org = await auth.api.createOrganization({
    body: { name: ORG_NAME, slug: ORG_SLUG, userId: owner.id, metadata: { demo: true, clock: now.toISOString() } },
  });
  if (!org?.id) throw new Error("Better Auth did not create the demo organization");
  await db.update(organizations).set({ createdAt: new Date(now.getTime() - 120 * 86_400_000) }).where(eq(organizations.id, org.id));

  const ctx: DemoContext = {
    organizationId: org.id,
    now,
    rand: createRng(20261008),
    users: {} as DemoContext["users"],
    companies: [],
    people: [],
    pools: { email: [], linkedin: [], whatsapp: [], unassigned: [] },
    pipelineId: "",
    replies: [],
    summary: {},
  };

  const { runInOrganization } = await import("@/lib/tenancy/scope");
  await runInOrganization(org.id, async () => {
    const step = async (label: string, fn: () => Promise<void>) => {
      const started = Date.now();
      process.stdout.write(`  ${label}…`);
      await fn();
      console.log(` ${((Date.now() - started) / 1000).toFixed(1)}s`);
    };
    const { seedCore } = await import("./demo/core");
    const { seedCrmSetup, seedCrmOutcomes } = await import("./demo/crm");
    const { seedEmail } = await import("./demo/email");
    const { seedLinkedin } = await import("./demo/linkedin");
    const { seedWhatsapp } = await import("./demo/whatsapp");
    const { seedAiCalling } = await import("./demo/aiCalling");
    const { seedWorkspace } = await import("./demo/workspace");
    const { seedPosts } = await import("./demo/posts");
    const { seedExtras } = await import("./demo/extras");
    const { finalizeDemo } = await import("./demo/finalize");

    console.log(`Seeding "${ORG_NAME}" (${org.id})`);
    await step("team, companies and people", () => seedCore(ctx, owner.id));
    await step("CRM sequences, knowledge and instructions", () => seedCrmSetup(ctx));
    await step("email campaigns, mailboxes and replies", () => seedEmail(ctx));
    await step("LinkedIn accounts, campaigns and conversations", () => seedLinkedin(ctx));
    await step("WhatsApp numbers, chats, campaigns and calls", () => seedWhatsapp(ctx));
    await step("AI calling: numbers, campaigns, agent calls", () => seedAiCalling(ctx));
    await step("CRM classifications, pipeline and drafts", () => seedCrmOutcomes(ctx));
    await step("Tables and prospecting", () => seedWorkspace(ctx));
    await step("LinkedIn posts, writing voices and the content brief", () => seedPosts(ctx));
    await step("IMAP mailbox, API keys, manual outreach", () => seedExtras(ctx));
    await step("finishing touches", () => finalizeDemo(ctx));
  });

  console.log("");
  console.log(`Demo organization "${ORG_NAME}" created with:`);
  for (const [label, n] of Object.entries(ctx.summary)) console.log(`  ${String(n).padStart(5)}  ${label}`);
  console.log("");
  console.log("Sign in:");
  console.log(`  email     ${DEMO_USER_EMAIL}`);
  console.log(`  password  ${DEMO_PASSWORD}`);
  console.log("  Start the app (bun run dev) and open /sign-in — or set DEMO_MODE=true and open /demo.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
