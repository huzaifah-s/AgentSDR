/**
 * LinkedIn posts, end to end, against a RUNNING dev server and a mock Unipile:
 * the publish path (one call per publish, never a retry, refusals and
 * uncertain failures, the daily limit, the stale-publishing sweep) and
 * isolation (a second organization cannot list, open, edit, delete,
 * publish, upload to or count the first one's posts).
 *
 * Phase 2, AI drafts: the generate and rewrite routes (409 without
 * OpenRouter, 400 for another organization's account or Knowledge, both
 * before anything is read from LinkedIn), and the drafting path itself run
 * in this process with a fake completion — Knowledge read whole, only public
 * always-include Knowledge added on its own, the author's past posts read
 * through the mock Unipile and cached — and the AI draft's source and
 * generation recorded when a post is saved. No model is ever called:
 * organization A's OpenRouter is switched off for the route calls (restored
 * at the end) and organization B never has one.
 *
 * Phase 4, prospects' themes: a seeded prospect (a person, a company and a
 * transcribed call in A, removed at the end). The themes route answers 409
 * without OpenRouter; in this process, the themes call sees the call's words
 * with the prospect redacted, a theme naming them is dropped, a draft naming
 * them is withheld, the saved post keeps the sealed summary and no ids, a
 * tampered source is refused, and the leak guard blocks scheduling and
 * publishing an edited post that names them. B sees none of A's messages and
 * cannot use A's theme.
 *
 *   MOCK_TLS_CERT=cert.pem MOCK_TLS_KEY=key.pem \
 *   INITIAL_OWNER_EMAIL=… INITIAL_OWNER_PASSWORD=… \
 *   BASE_URL=http://localhost:3100 bun run --conditions=react-server scripts/e2e/linkedin-posts.ts
 *
 * Unipile's base URL must be https, so the mock serves TLS with a
 * self-signed localhost certificate; start the server under test with
 * NODE_EXTRA_CA_CERTS=<that cert> so it trusts it. Nothing reaches the real
 * Unipile or LinkedIn. Needs AUTH_SIGNUP=open on the server (organization B
 * signs up) and refuses to run unless DATABASE_URL is local: it rewrites
 * organization A's Unipile credentials for the run (restored at the end)
 * and turns its R2 integration off for the run, so nothing reaches R2.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:https";
import postgres from "postgres";
import { createKnowledgeDocument } from "@/lib/crm/knowledge-service";
import { encryptIntegrationCredentials } from "@/lib/integrations/credentials";
import { draftPosts, postThemes, rewritePostDraft, suggestPostIdeas } from "@/lib/linkedin/posts/ai.server";
import { learnAuthorVoice } from "@/lib/linkedin/posts/voices.server";
import { UNCERTAIN_PUBLISH_ERROR, type PostDraftsResponse, type PostTheme } from "@/lib/linkedin/posts/contract";
import type { PostCompletion, PostCompletionInput } from "@/lib/linkedin/posts/draft";
import { createVoiceLoader, readPastPostsFromUnipile } from "@/lib/linkedin/posts/voice.server";
import { runInOrganization } from "@/lib/tenancy/scope";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 3199);
const MOCK_BASE = `https://localhost:${MOCK_PORT}`;

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL!, { ssl: false, max: 2, onnotice: () => {} });

// ------------------------------------------------------------ mock Unipile

type MockCall = { accountId: string; text: string; attachments: number };
const mockCalls: MockCall[] = [];
/** Reads of an account's own profile and posts (the author's voice), by Unipile account id. */
const voiceCalls: string[] = [];
/** What the mock returns as an account's past posts; accounts not listed have none. */
const pastPostsByAccount = new Map<string, { text: string; is_repost?: boolean }[]>();

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Behaviour is chosen by a marker in the post's text: [mock:400], [mock:500], [mock:drop], [mock:nullid]. */
const mock = createServer({ cert: readFileSync(process.env.MOCK_TLS_CERT!), key: readFileSync(process.env.MOCK_TLS_KEY!) }, async (req, res) => {
  const raw = await readBody(req);
  const url = new URL(req.url ?? "/", MOCK_BASE);
  if (req.method === "GET" && req.headers["x-api-key"] === "mock-key") {
    const accountId = url.searchParams.get("account_id") ?? "";
    if (url.pathname === "/api/v1/users/me") {
      voiceCalls.push(accountId);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "AccountOwnerProfile", provider: "LINKEDIN", provider_id: `prov-${accountId}` }));
    }
    const posts = url.pathname.match(/^\/api\/v1\/users\/prov-([^/]+)\/posts$/);
    if (posts && decodeURIComponent(posts[1]) === accountId) {
      voiceCalls.push(accountId);
      const items = (pastPostsByAccount.get(accountId) ?? []).map((item, index) => ({ object: "Post", id: `post-${index}`, is_repost: false, ...item }));
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "PostList", items, cursor: null }));
    }
  }
  if (req.method !== "POST" || req.url !== "/api/v1/posts" || req.headers["x-api-key"] !== "mock-key") {
    res.writeHead(404).end(JSON.stringify({ title: "Not found" }));
    return;
  }
  const form = await new Response(new Uint8Array(raw), { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
  const text = String(form.get("text") ?? "");
  mockCalls.push({ accountId: String(form.get("account_id")), text, attachments: form.getAll("attachments").length });
  if (text.includes("[mock:drop]")) return req.socket.destroy();
  if (text.includes("[mock:400]")) return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ title: "Bad request", detail: "Mock refusal" }));
  if (text.includes("[mock:500]")) return res.writeHead(503).end("upstream down");
  const postId = text.includes("[mock:nullid]") ? null : `72${Date.now()}`;
  res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ object: "PostCreated", post_id: postId }));
});

// ---------------------------------------------------------------- sessions

type Session = { cookie: string; label: string };

function cookiesFrom(res: Response, previous = ""): string {
  const jar = new Map(previous.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as const));
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0];
    jar.set(pair.split("=")[0], pair);
  }
  return [...jar.values()].join("; ");
}

async function authPost(path: string, body: unknown, cookie = ""): Promise<Response> {
  return fetch(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

async function signIn(email: string, password: string, label: string): Promise<Session> {
  const res = await authPost("/sign-in/email", { email, password });
  if (!res.ok) throw new Error(`${label}: sign-in failed (${res.status}) ${await res.text()}`);
  return { cookie: cookiesFrom(res), label };
}

async function call(s: Session, method: string, url: string, body?: unknown | FormData): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const form = body instanceof FormData;
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { cookie: s.cookie, origin: BASE, "sec-fetch-site": "same-origin", ...(form || body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* pages and redirects */
  }
  return { status: res.status, json, text };
}

// ------------------------------------------------------------ assertions

const failures: string[] = [];
let checks = 0;
function check(ok: boolean, what: string, detail?: unknown) {
  checks++;
  if (!ok) failures.push(`${what}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}`}`);
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}`);
}

type PostJson = { id: string; status: string; error: string | null; postUrl: string | null; publishedBy: { id: string } | null; body: string };

async function connectUnipile(organizationId: string) {
  const payload = encryptIntegrationCredentials({ baseUrl: MOCK_BASE, apiKey: "mock-key", notifySecret: "mock-secret" });
  const [existing] = await sql<{ id: string }[]>`select id from grid_providers where organization_id = ${organizationId} and key = 'platform-unipile'`;
  if (existing) {
    await sql`update grid_provider_credentials set encrypted_payload = ${payload} where provider_id = ${existing.id}`;
    return;
  }
  const [row] = await sql<{ id: string }[]>`
    insert into grid_providers (organization_id, key, name, config, enabled)
    values (${organizationId}, 'platform-unipile', 'Platform integration', ${sql.json({ platformKey: "unipile", values: { baseUrl: MOCK_BASE }, secretsSet: ["apiKey"], verifiedAt: new Date().toISOString() })}, true)
    returning id`;
  await sql`insert into grid_provider_credentials (provider_id, encrypted_payload) values (${row.id}, ${payload})`;
}

/**
 * Archives the Knowledge documents this script creates (titled "E2E …") in an
 * organization, so a re-run starts from the same Knowledge. Archived, not
 * deleted: document versions are append-only, and archived documents are
 * left out of every Knowledge read the posts code does.
 */
async function removeE2eKnowledge(organizationId: string) {
  await sql`update crm_knowledge_documents set active = false where organization_id = ${organizationId} and title like 'E2E %' and active`;
}

async function snapshot(id: string): Promise<string> {
  return JSON.stringify(await sql`select * from linkedin_posts where id = ${id}`);
}

// ------------------------------------------------------------------ run

async function main() {
  const ownerEmail = process.env.INITIAL_OWNER_EMAIL;
  const ownerPassword = process.env.INITIAL_OWNER_PASSWORD;
  if (!ownerEmail || !ownerPassword) throw new Error("INITIAL_OWNER_EMAIL / INITIAL_OWNER_PASSWORD are required");
  await new Promise<void>((resolve) => mock.listen(MOCK_PORT, resolve));

  const [orgA] = await sql<{ id: string }[]>`
    select o.id from organizations o join members m on m.organization_id = o.id join users u on u.id = m.user_id
     where lower(u.email) = lower(${ownerEmail}) and m.role like '%owner%' order by o.created_at limit 1`;
  if (!orgA) throw new Error(`${ownerEmail} owns no organization`);

  // A: Unipile → the mock, R2 off, OpenRouter off for the AI routes. Kept to restore afterwards.
  let savedByok: Record<string, unknown> | null = null;
  /** The Phase 4 prospect seeded in A, removed at the end. */
  let prospect: { personId: string; companyId: string; callId: string } | null = null;
  /** A's brief before the run (Phase 5), put back at the end; undefined = not touched. */
  let savedBrief: { pipelineId: string; postInstructions: unknown } | undefined;
  const [savedUnipile] = await sql<{ id: string; payload: string }[]>`
    select c.provider_id as id, c.encrypted_payload as payload from grid_provider_credentials c join grid_providers g on g.id = c.provider_id
     where g.organization_id = ${orgA.id} and g.key = 'platform-unipile'`;
  const [savedR2] = await sql<{ enabled: boolean }[]>`select enabled from grid_providers where organization_id = ${orgA.id} and key = 'platform-r2'`;
  await connectUnipile(orgA.id);
  await sql`update grid_providers set enabled = false where organization_id = ${orgA.id} and key = 'platform-r2'`;

  try {
    const accounts = await sql<{ id: string; linkedinId: string; name: string }[]>`
      select id, "linkedinId", name from "LinkedInAccount" where "organizationId" = ${orgA.id} and status = 'CONNECTED' order by name limit 2`;
    if (accounts.length < 2) throw new Error("A needs two connected LinkedIn accounts (run db:seed:demo)");
    const [acc, acc2] = accounts;
    // Start each run from an account with nothing published today.
    await sql`delete from linkedin_posts where organization_id = ${orgA.id}`;
    await removeE2eKnowledge(orgA.id);

    console.log("waiting 31 s for the server's 30 s integration cache…");
    await Bun.sleep(31_000);

    const a = await signIn(ownerEmail, ownerPassword, "A");
    console.log("\nA: drafts, publishing, the daily limit");

    const create = (body: string, account = acc.id) => call(a, "POST", "/api/linkedin/posts", { linkedinAccountId: account, body });
    const publish = (id: string) => call(a, "POST", `/api/linkedin/posts/${id}/publish`);

    const empty = await create("");
    check(empty.status === 201, "an empty draft can be saved", empty.json);
    const emptyId = (empty.json.post as PostJson).id;
    const emptyPublish = await publish(emptyId);
    check(emptyPublish.status === 400 && mockCalls.length === 0, "an empty post is refused before Unipile", emptyPublish.json);

    const tooLong = await call(a, "PATCH", `/api/linkedin/posts/${emptyId}`, { body: "x".repeat(3001) });
    check(tooLong.status === 400, "more than 3,000 characters is refused", tooLong.json);

    const first = await create("Hello from the e2e test.\nSecond line.");
    const firstId = (first.json.post as PostJson).id;
    const edited = await call(a, "PATCH", `/api/linkedin/posts/${firstId}`, { body: "Hello from the e2e test, edited.\nSecond line." });
    check(edited.status === 200 && (edited.json.post as PostJson).body.includes("edited"), "a draft can be edited", edited.json);

    const ok1 = await publish(firstId);
    const post1 = ok1.json.post as PostJson;
    check(ok1.status === 200 && post1.status === "published", "publish now publishes", ok1.json);
    check(mockCalls.length === 1 && mockCalls[0].accountId === acc.linkedinId && mockCalls[0].text.includes("edited"), "one Unipile call, as the account's Unipile id, with the saved text", mockCalls);
    check(/^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:\d+\/$/.test(post1.postUrl ?? ""), "the post gets a feed link", post1.postUrl);
    check(Boolean(post1.publishedBy?.id), "who published it is recorded", post1.publishedBy);

    const again = await publish(firstId);
    check(again.status === 409 && mockCalls.length === 1, "publishing a published post again is refused, no second call", again.json);
    const editPublished = await call(a, "PATCH", `/api/linkedin/posts/${firstId}`, { body: "changed" });
    check(editPublished.status === 409, "a published post cannot be edited", editPublished.json);
    const deletePublished = await call(a, "DELETE", `/api/linkedin/posts/${firstId}`);
    check(deletePublished.status === 409, "a published post cannot be deleted", deletePublished.json);

    // Refusal (4xx): failed with the reason, nothing counted.
    const refused = await create("Refuse me [mock:400]");
    const refusedId = (refused.json.post as PostJson).id;
    const r = await publish(refusedId);
    const rPost = r.json.post as PostJson;
    check(rPost.status === "failed" && (rPost.error ?? "").includes("Mock refusal") && !(rPost.error ?? "").startsWith(UNCERTAIN_PUBLISH_ERROR), "a 4xx fails the post with LinkedIn's reason", rPost);
    const callsAfterRefusal = mockCalls.length;
    const retryFailed = await publish(refusedId);
    check(retryFailed.status === 409 && mockCalls.length === callsAfterRefusal, "a failed post is not republished until edited", retryFailed.json);
    const backToDraft = await call(a, "PATCH", `/api/linkedin/posts/${refusedId}`, { body: "Fixed text" });
    check((backToDraft.json.post as PostJson).status === "draft" && (backToDraft.json.post as PostJson).error === null, "editing a failed post makes it a draft again", backToDraft.json);

    // Uncertain (5xx, dropped connection): failed as "may have been posted", exactly one call each.
    for (const marker of ["[mock:500]", "[mock:drop]"]) {
      const before = mockCalls.length;
      const p = await create(`Uncertain ${marker}`, acc2.id);
      const res = await publish((p.json.post as PostJson).id);
      const after = res.json.post as PostJson;
      check(after.status === "failed" && (after.error ?? "").startsWith(UNCERTAIN_PUBLISH_ERROR), `${marker}: failed as "may have been posted"`, after);
      check(mockCalls.length === before + 1, `${marker}: exactly one Unipile call, no retry`, mockCalls.length - before);
    }

    // A null post id: published, no link.
    const nullId = await create("No id please [mock:nullid]", acc2.id);
    const n = await publish((nullId.json.post as PostJson).id);
    check((n.json.post as PostJson).status === "published" && (n.json.post as PostJson).postUrl === null, "post_id null: published, with no link", n.json);

    // The daily limit (default 2): acc has 1 published; a second goes, a third is refused before Unipile.
    const second = await create("Second post today");
    check(((await publish((second.json.post as PostJson).id)).json.post as PostJson).status === "published", "the second post of the day goes out");
    const third = await create("Third post today");
    const beforeThird = mockCalls.length;
    const t = await publish((third.json.post as PostJson).id);
    check(t.status === 429 && mockCalls.length === beforeThird, "the third post of the day is refused (postsPerDay = 2), no Unipile call", t.json);
    check(((await call(a, "GET", `/api/linkedin/posts/${(third.json.post as PostJson).id}`)).json.post as PostJson).status === "draft", "a refused post stays a draft");

    // Images without R2: refused, text-only still works.
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], "x.png", { type: "image/png" }));
    const upload = await call(a, "POST", `/api/linkedin/posts/${emptyId}/images`, form);
    check(upload.status === 409 && String(upload.json.error).includes("R2"), "an image upload without R2 answers 409", upload.json);

    // A post a crashed process left in `publishing` fails as uncertain when the list is read.
    const stuck = await create("Stuck");
    const stuckId = (stuck.json.post as PostJson).id;
    await sql`update linkedin_posts set status = 'publishing', updated_at = now() - interval '6 minutes' where id = ${stuckId}`;
    await call(a, "GET", "/api/linkedin/posts");
    const [stuckRow] = await sql<{ status: string; error: string }[]>`select status, error from linkedin_posts where id = ${stuckId}`;
    check(stuckRow.status === "failed" && stuckRow.error.startsWith(UNCERTAIN_PUBLISH_ERROR), "a post stuck publishing over 5 minutes is failed as uncertain", stuckRow);

    const deleteDraft = await call(a, "DELETE", `/api/linkedin/posts/${emptyId}`);
    check(deleteDraft.status === 200 && (await sql`select 1 from linkedin_posts where id = ${emptyId}`).length === 0, "a draft can be deleted", deleteDraft.json);

    const pageA = await call(a, "GET", `/linkedin/posts/${firstId}`);
    check(pageA.status === 200 && pageA.text.includes("Hello from the e2e test"), "A opens its own post's page", pageA.status);

    // ------------------------------------------------- Phase 2: AI drafts (A)
    console.log("\nA: AI drafts");
    const knowledge = await runInOrganization(orgA.id, async () => ({
      publicAlways: await createKnowledgeDocument({ title: "E2E public company note", kind: "company", tags: ["public"], alwaysInclude: true, content: "E2E-PUBLIC-MARKER Northwind helps sales teams." }),
      privateAlways: await createKnowledgeDocument({ title: "E2E private pricing", kind: "pricing", tags: [], alwaysInclude: true, content: "E2E-PRIVATE-MARKER Our floor price is 40% off." }),
      caseStudy: await createKnowledgeDocument({ title: "E2E case study", kind: "case_study", tags: [], alwaysInclude: false, content: `Acme cut onboarding from 14 days to 3. ${"Detail. ".repeat(4_000)}E2E-END-OF-CASE` }),
    }));
    const caseId = knowledge.caseStudy.id;
    const publicId = knowledge.publicAlways.id;
    pastPostsByAccount.set(acc.linkedinId, [
      { text: "We doubled reply rates by writing shorter emails. #sales" },
      { text: "Someone else's post, reposted", is_repost: true },
      { text: "Second own post." },
    ]);

    const [byok] = await sql<{ config: Record<string, unknown> }[]>`select config from grid_providers where organization_id = ${orgA.id} and key = 'openrouter-byok-settings'`;
    savedByok = byok?.config ?? null;
    if (savedByok?.byokOnlyConfirmed === true) {
      // Rendering checks the settings and builds a client; it calls no model.
      const ready = await call(a, "GET", "/linkedin/posts/new");
      check(ready.text.includes("Write with AI") && ready.text.includes("E2E case study"), "with OpenRouter ready, the composer shows Write with AI and the Knowledge to pick", ready.status);
    }
    // From here on A has no usable OpenRouter: no route call can reach a model.
    await sql`update grid_providers set config = jsonb_set(config, '{byokOnlyConfirmed}', 'false') where organization_id = ${orgA.id} and key = 'openrouter-byok-settings'`;
    const notReady = await call(a, "GET", "/linkedin/posts/new");
    check(notReady.status === 200 && !notReady.text.includes("Write with AI"), "without OpenRouter, the composer has no AI panel", notReady.status);

    const voiceBefore = voiceCalls.length;
    const gen409 = await call(a, "POST", "/api/linkedin/posts/generate", { linkedinAccountId: acc.id, topic: "Shorter emails", knowledgeDocumentIds: [caseId] });
    check(gen409.status === 409 && String(gen409.json.error).includes("OpenRouter"), "generate answers 409 when OpenRouter is not ready", gen409.json);
    const rew409 = await call(a, "POST", "/api/linkedin/posts/rewrite", { linkedinAccountId: acc.id, body: "Some text", instruction: "shorter" });
    check(rew409.status === 409 && String(rew409.json.error).includes("OpenRouter"), "rewrite answers 409 when OpenRouter is not ready", rew409.json);
    check(voiceCalls.length === voiceBefore, "nothing is read from LinkedIn when OpenRouter is not ready", voiceCalls.length - voiceBefore);
    const genEmpty = await call(a, "POST", "/api/linkedin/posts/generate", { linkedinAccountId: acc.id, topic: " " });
    check(genEmpty.status === 400, "generate needs a topic or a document", genEmpty.json);
    const genUnknown = await call(a, "POST", "/api/linkedin/posts/generate", { linkedinAccountId: acc.id, knowledgeDocumentIds: ["00000000-0000-4000-8000-000000000000"] });
    check(genUnknown.status === 400, "generate refuses an unknown Knowledge document", genUnknown.json);

    // The drafting path itself, in this process, with a fake completion.
    const prompts: PostCompletionInput[] = [];
    const fake = (bodies: string[]): PostCompletion => async (input) => {
      prompts.push(input);
      const text = JSON.stringify({ posts: bodies.map((body) => ({ body })) });
      input.accept(text);
      return { text, provider: "fake", model: "fake/e2e-model" };
    };
    const voices = createVoiceLoader({ read: readPastPostsFromUnipile });
    const deps = (bodies: string[]) => ({ complete: fake(bodies), loadVoice: voices.loadAuthorVoice, skipOpenRouterCheck: true });
    const voiceStart = voiceCalls.length;
    const drafts: PostDraftsResponse = await runInOrganization(orgA.id, () =>
      draftPosts({ linkedinAccountId: acc.id, topic: "Shorter emails", knowledgeDocumentIds: [caseId] }, deps(["Draft one #sales", "Draft two", "Draft three"])),
    );
    const sent = prompts.at(-1)!;
    check(drafts.variants.length === 3 && drafts.variants[0].body === "Draft one #sales", "three drafts come back", drafts.variants);
    check(sent.userPrompt.includes("E2E-END-OF-CASE") && sent.userPrompt.includes("Acme cut onboarding"), "a picked document is read whole, end included", sent.userPrompt.length);
    check(sent.userPrompt.includes("E2E-PUBLIC-MARKER"), "always-include Knowledge tagged public is added");
    check(!sent.userPrompt.includes("E2E-PRIVATE-MARKER"), "always-include Knowledge without the public tag is not added");
    check(sent.userPrompt.includes("We doubled reply rates") && sent.userPrompt.includes("Second own post.") && !sent.userPrompt.includes("reposted"), "the author's own past posts, not reposts, come from Unipile", sent.userPrompt.slice(0, 400));
    check(sent.systemPrompt.includes("at most 3 relevant ones"), "hashtags are allowed because the author's past posts use them");
    check(sent.userPrompt.includes(acc.name), "the author's name is in the prompt");
    check(voiceCalls.length - voiceStart === 2 && voiceCalls.slice(voiceStart).every((id) => id === acc.linkedinId), "the voice is read as the account (own profile, then its posts)", voiceCalls.slice(voiceStart));
    check(JSON.stringify(drafts.source) === JSON.stringify({ kind: "knowledge", topic: "Shorter emails", knowledgeDocumentIds: [caseId, publicId] }), "the source names the topic and every document used", drafts.source);
    check(drafts.generation.model === "fake/e2e-model" && drafts.generation.prompts.map((p) => p.name).join() === "linkedin/post-system,linkedin/post-user,linkedin/post-tool", "the generation names the model and prompts", drafts.generation);
    check(drafts.voice.status === "read" && drafts.voice.pastPosts === 2, "the answer says the voice came from 2 past posts", drafts.voice);
    check(sent.trace.name === "linkedin-post-draft", "traced as linkedin-post-draft");

    await runInOrganization(orgA.id, () => draftPosts({ linkedinAccountId: acc.id, topic: "Again", knowledgeDocumentIds: [] }, deps(["A", "B", "C"])));
    check(voiceCalls.length - voiceStart === 2, "a second draft within the hour reuses the cached voice", voiceCalls.length - voiceStart);

    const noPosts = await runInOrganization(orgA.id, () => draftPosts({ linkedinAccountId: acc2.id, topic: "Hiring", knowledgeDocumentIds: [] }, deps(["A", "B", "C"])));
    check(noPosts.voice.status === "none" && prompts.at(-1)!.systemPrompt.includes("There are no past posts by the author"), "an account without posts gets a plain first-person voice", noPosts.voice);
    check(noPosts.source.kind === "topic", "a topic-only draft records kind topic", noPosts.source);

    const rewrite = await runInOrganization(orgA.id, () =>
      rewritePostDraft({ linkedinAccountId: acc.id, topic: null, knowledgeDocumentIds: [], body: "A long post about emails.", instruction: "shorter" }, deps(["Short post."])),
    );
    check(rewrite.variants.length === 1 && prompts.at(-1)!.trace.name === "linkedin-post-rewrite" && prompts.at(-1)!.userPrompt.includes("A long post about emails."), "a rewrite gives one variant of the current text", rewrite);
    check(rewrite.generation.prompts.some((p) => p.name === "linkedin/post-rewrite"), "the rewrite's generation names linkedin/post-rewrite");

    // Using a draft: saving records its source and generation.
    const saved = await call(a, "POST", "/api/linkedin/posts", { linkedinAccountId: acc.id, body: drafts.variants[1].body, source: drafts.source, generation: drafts.generation });
    const savedId = (saved.json.post as PostJson)?.id;
    const [savedRow] = await sql<{ source: unknown; generation: unknown }[]>`select source, generation from linkedin_posts where id = ${savedId ?? null}`;
    check(saved.status === 201 && JSON.stringify(savedRow?.source) === JSON.stringify(drafts.source) && JSON.stringify(savedRow?.generation) === JSON.stringify(drafts.generation), "a saved AI draft records its source and generation", savedRow);
    const patched = await call(a, "PATCH", `/api/linkedin/posts/${savedId}`, { body: rewrite.variants[0].body, source: drafts.source, generation: rewrite.generation });
    const [patchedRow] = await sql<{ generation: { prompts: { name: string }[] } }[]>`select generation from linkedin_posts where id = ${savedId ?? null}`;
    check(patched.status === 200 && patchedRow.generation.prompts.some((p) => p.name === "linkedin/post-rewrite"), "using a rewrite records its generation", patchedRow);
    const badSource = await call(a, "POST", "/api/linkedin/posts", { linkedinAccountId: acc.id, body: "x", source: { kind: "knowledge", knowledgeDocumentIds: ["00000000-0000-4000-8000-000000000000"] } });
    check(badSource.status === 400, "a source naming an unknown Knowledge document is refused", badSource.json);
    const conversations = await call(a, "POST", "/api/linkedin/posts", { linkedinAccountId: acc.id, body: "x", source: { kind: "conversations", themeSummary: "x" } });
    check(conversations.status === 400, "a client cannot claim a conversations source (Phase 4 writes it)", conversations.json);

    // ------------------------------------------- Phase 4: prospects' themes (A)
    console.log("\nA: what prospects say");
    const [company] = await sql<{ id: string }[]>`
      insert into companies (organization_id, domain, name, source) values (${orgA.id}, 'quillfeather-e2e.test', 'Quillfeather Labs Ltd', 'e2e') returning id`;
    const [person] = await sql<{ id: string }[]>`
      insert into people (organization_id, first_name, last_name, full_name, email, phone, company_id, source)
      values (${orgA.id}, 'Zelda', 'Quill', 'Zelda Quill', 'zelda@quillfeather-e2e.test', '+15550104242', ${company.id}, 'e2e') returning id`;
    const [callRow] = await sql<{ id: string }[]>`
      insert into call_sessions (organization_id, person_id, phone, status, recording_key, upload_token_hash, token_expires_at, transcript_status, transcript, started_at, ended_at)
      values (${orgA.id}, ${person.id}, '+15550104242', 'recorded', 'e2e/none.webm', 'e2e-not-a-token', now(), 'done',
        ${sql.json({ language: "en", summary: "E2E call", model: "fake/model", utterances: [
          { startSeconds: 0, speaker: "rep", text: "Hi Zelda" },
          { startSeconds: 2, speaker: "lead", text: "I'm Zelda Quill at Quillfeather Labs. E2E-RAW-WORDS: setup took us months with the last vendor. Call me on +1 555 010 4242." },
        ] } as never)}, now() - interval '1 hour', now() - interval '50 minutes')
      returning id`;
    prospect = { personId: person.id, companyId: company.id, callId: callRow.id };

    const themes409 = await call(a, "POST", "/api/linkedin/posts/themes", {});
    check(themes409.status === 409 && String(themes409.json.error).includes("OpenRouter"), "the themes route answers 409 without OpenRouter", themes409.json);

    const themePrompts: PostCompletionInput[] = [];
    const fakeThemes: PostCompletion = async (input) => {
      themePrompts.push(input);
      const range = (input.jsonSchema as { properties: { themes: { minItems: number } } }).properties.themes;
      const list = [{ title: "Quillfeather Labs wants faster setup", kind: "objection", summary: "Quillfeather Labs keeps asking.", mentions: 1 }];
      for (let i = list.length; i < range.minItems; i += 1) list.push({ title: `E2E theme ${i}`, kind: "pain_point", summary: `Setup takes too long for many teams (${i}).`, mentions: 1 });
      if (list.length < 2) list.push({ title: "E2E theme setup", kind: "pain_point", summary: "Setup takes too long for many teams.", mentions: 1 });
      const text = JSON.stringify({ themes: list.slice(0, Math.max(range.minItems, 2)) });
      input.accept(text);
      return { text, provider: "fake", model: "fake/e2e-model" };
    };
    const found = await runInOrganization(orgA.id, () => postThemes({ complete: fakeThemes, skipOpenRouterCheck: true }));
    const themesSent = themePrompts.at(-1)!;
    check(themesSent.userPrompt.includes("E2E-RAW-WORDS") && themesSent.userPrompt.includes("setup took us months"), "the themes call reads the lead's side of a recent call", themesSent.userPrompt.length);
    check(!/Zelda|Quill|5550104242|555 010 4242/.test(themesSent.userPrompt) && !themesSent.userPrompt.includes("Hi Zelda"), "the prospect's name, company and phone are redacted, and the rep's side is not read");
    check(themesSent.trace.name === "linkedin-post-themes", "traced as linkedin-post-themes");
    check(found.withheld === 1 && found.themes.every((item) => !item.title.includes("Quillfeather")), "a theme naming the prospect's company is dropped", found);
    check(found.themes.length >= 1 && found.themes.every((item) => item.seal && item.readAt), "the other themes come back sealed, with the time they were read", found.themes.length);
    const picked: PostTheme = found.themes[0]!;

    const themeDrafts = await runInOrganization(orgA.id, () =>
      draftPosts({ linkedinAccountId: acc.id, topic: null, knowledgeDocumentIds: [], theme: picked }, deps(["Setup should not take months.", "Zelda Quill told me setup was slow.", "Most teams wait too long to start."])),
    );
    const themeSent = prompts.at(-1)!;
    check(themeSent.userPrompt.includes(picked.summary) && !themeSent.userPrompt.includes("E2E-RAW-WORDS"), "the draft is written from the theme's summary, never the messages");
    check(themeDrafts.variants.length === 2 && themeDrafts.withheld.length === 1 && themeDrafts.withheld[0]!.matched.includes("Zelda Quill (a name)"), "a draft naming the prospect is withheld, saying what matched", themeDrafts);
    const themeSource = themeDrafts.source;
    check(
      themeSource.kind === "conversations" && themeSource.themeSummary === picked.summary && Boolean(themeSource.seal) && !JSON.stringify(themeSource).includes(person.id) && !JSON.stringify(themeSource).includes(callRow.id),
      "the source keeps the sealed summary and no message or person id",
      themeSource,
    );

    const themePost = await call(a, "POST", "/api/linkedin/posts", { linkedinAccountId: acc.id, body: themeDrafts.variants[0]!.body, source: themeSource, generation: themeDrafts.generation });
    const themePostId = (themePost.json.post as PostJson)?.id;
    const [themeRow] = await sql<{ source: Record<string, unknown> }[]>`select source from linkedin_posts where id = ${themePostId ?? null}`;
    check(themePost.status === 201 && themeRow?.source.kind === "conversations" && !JSON.stringify(themeRow.source).includes(person.id), "a post from a theme is saved with its conversations source", themeRow);
    const tampered = await call(a, "POST", "/api/linkedin/posts", { linkedinAccountId: acc.id, body: "x", source: { ...themeSource, themeSummary: `${themeSource.themeSummary} (edited)` } });
    check(tampered.status === 400, "a source whose theme was edited in the browser is refused", tampered.json);
    const tamperedTheme = await call(a, "POST", "/api/linkedin/posts/generate", { linkedinAccountId: acc.id, theme: { ...picked, readAt: "2020-01-01T00:00:00.000Z" } });
    check(tamperedTheme.status === 400, "generate refuses a theme whose read time was moved (before the OpenRouter check)", tamperedTheme.json);

    const leaky = await call(a, "PATCH", `/api/linkedin/posts/${themePostId}`, { body: "Setup should not take months. Ask Zelda at Quillfeather Labs, or call 555-010-4242." });
    check(leaky.status === 200, "an edit is saved as it is (the guard runs at schedule and publish)", leaky.status);
    const callsBeforeLeak = mockCalls.length;
    const leakPublish = await call(a, "POST", `/api/linkedin/posts/${themePostId}/publish`);
    check(leakPublish.status === 409 && String(leakPublish.json.error).includes("Quillfeather Labs (a company)"), "publishing an edited post that names the prospect is refused, saying what matched", leakPublish.json);
    check(mockCalls.length === callsBeforeLeak, "nothing reached Unipile");
    const [afterLeak] = await sql<{ status: string }[]>`select status from linkedin_posts where id = ${themePostId}`;
    check(afterLeak.status === "draft", "the refused post stays a draft", afterLeak);
    const tomorrow = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString();
    const leakSchedule = await call(a, "POST", `/api/linkedin/posts/${themePostId}/schedule`, { date: tomorrow.slice(0, 10), time: "10:00" });
    check(leakSchedule.status === 409 && String(leakSchedule.json.error).includes("names someone"), "scheduling it is refused too", leakSchedule.json);

    const sticky = await call(a, "PATCH", `/api/linkedin/posts/${themePostId}`, { body: "Setup should not take months.", source: { kind: "topic", topic: "Setup" }, generation: null });
    const [stickyRow] = await sql<{ source: Record<string, unknown> }[]>`select source from linkedin_posts where id = ${themePostId}`;
    check(sticky.status === 200 && stickyRow.source.kind === "conversations", "a later topic draft does not take the post out of the guard", stickyRow.source);
    const cleanSchedule = await call(a, "POST", `/api/linkedin/posts/${themePostId}/schedule`, { date: tomorrow.slice(0, 10), time: "10:00" });
    check(cleanSchedule.status === 200, "the clean text schedules", cleanSchedule.json);
    const unscheduled = await call(a, "DELETE", `/api/linkedin/posts/${themePostId}/schedule`);
    check(unscheduled.status === 200, "and unschedules again", unscheduled.status);

    const rewriteTheme = await runInOrganization(orgA.id, () =>
      rewritePostDraft({ linkedinAccountId: acc.id, topic: null, knowledgeDocumentIds: [], theme: picked, body: "Setup should not take months.", instruction: "shorter" }, deps(["Zelda Quill: setup is slow."])),
    );
    check(rewriteTheme.variants.length === 0 && rewriteTheme.withheld.length === 1 && rewriteTheme.source.kind === "conversations", "a rewrite from a theme is guarded and keeps its source", rewriteTheme);

    // --------------------------------------- Phase 5: the brief and voices (A)
    console.log("\nA: the content brief and writing voices");
    const instructionsA = await call(a, "GET", "/api/crm/settings/ai-instructions");
    check(
      instructionsA.status === 200 && Array.isArray(instructionsA.json.postInstructions) && typeof instructionsA.json.postInstructionsCustomized === "boolean",
      "the Instructions API carries the LinkedIn post brief",
      instructionsA.json.postInstructionsCustomized,
    );
    const pipelineA = String(instructionsA.json.pipelineId ?? "");
    const [briefRow] = await sql<{ post_instructions: unknown }[]>`select post_instructions from crm_settings where pipeline_id = ${pipelineA || null}`;
    savedBrief = { pipelineId: pipelineA, postInstructions: briefRow?.post_instructions ?? null };
    const briefPut = await call(a, "PUT", "/api/crm/settings/ai-instructions", {
      pipelineId: pipelineA,
      postInstructions: [
        { id: "never-post", title: "What we never post", content: "E2E-NEVER-MARKER never mention Contoso." },
        { id: "tone", title: "How we sound", content: "E2E-BRIEF-TONE formal and calm." },
      ],
    });
    check(briefPut.status === 200 && briefPut.json.postInstructionsCustomized === true, "A saves its own brief", briefPut.json);

    const voicePut = await call(a, "PUT", `/api/linkedin/posts/voices/${acc.id}`, {
      instructions: [{ id: "sound", title: "How I sound", content: "E2E-VOICE-MARKER casual, short sentences." }],
      examplePosts: ["E2E-EXAMPLE-POST Shipping beats planning."],
    });
    check(voicePut.status === 200 && (voicePut.json.voice as { examplePosts: string[] })?.examplePosts.length === 1, "A saves a writing voice for its account", voicePut.json);
    const [voiceRow] = await sql<{ updated_by: string | null; organization_id: string }[]>`select updated_by, organization_id from linkedin_author_voices where linkedin_account_id = ${acc.id}`;
    check(voiceRow?.organization_id === orgA.id && Boolean(voiceRow.updated_by), "the voice is A's, with who saved it", voiceRow);
    const voiceGet = await call(a, "GET", `/api/linkedin/posts/voices/${acc.id}`);
    check(voiceGet.text.includes("E2E-VOICE-MARKER"), "A reads the voice back", voiceGet.status);
    const composerA = await call(a, "GET", "/linkedin/posts/new");
    check(composerA.text.includes("E2E-VOICE-MARKER") && composerA.text.includes("?voice="), "the composer shows the account's voice in one line, with Edit", composerA.status);
    const badVoice = await call(a, "PUT", `/api/linkedin/posts/voices/${acc.id}`, { examplePosts: ["a", "b", "c", "d", "e", "f"] });
    check(badVoice.status === 400, "more than 5 example posts are refused", badVoice.json);

    const layered = await runInOrganization(orgA.id, () => draftPosts({ linkedinAccountId: acc.id, topic: "Make this one formal", knowledgeDocumentIds: [] }, deps(["L1", "L2", "L3"])));
    const layeredSystem = prompts.at(-1)!.systemPrompt;
    const iNever = layeredSystem.indexOf("E2E-NEVER-MARKER");
    const iVoice = layeredSystem.indexOf("E2E-VOICE-MARKER");
    check(iNever > -1 && iVoice > iNever && layeredSystem.includes("never to post always wins"), "the draft prompt has the brief, then the voice, and never-post wins", { iNever, iVoice });
    check(prompts.at(-1)!.userPrompt.includes("E2E-EXAMPLE-POST") && prompts.at(-1)!.userPrompt.includes("Make this one formal"), "example posts and this draft's notes reach the prompt");
    check(layered.variants.length === 3, "the layered draft comes back");

    const ideas409 = await call(a, "POST", "/api/linkedin/posts/ideas", {});
    check(ideas409.status === 409 && String(ideas409.json.error).includes("OpenRouter"), "ideas answer 409 without OpenRouter", ideas409.json);
    const learn409 = await call(a, "POST", `/api/linkedin/posts/voices/${acc.id}/learn`);
    check(learn409.status === 409 && String(learn409.json.error).includes("OpenRouter"), "Learn from my posts answers 409 without OpenRouter", learn409.json);

    const ideaPrompts: PostCompletionInput[] = [];
    const fakeIdeas: PostCompletion = async (input) => {
      ideaPrompts.push(input);
      const context = JSON.parse(input.userPrompt) as { knowledge: { ref: string }[]; themes: { ref: string }[] };
      const refK = context.knowledge[0]?.ref;
      const refT = context.themes[0]?.ref;
      const list = [
        { title: "E2E idea one", angle: "From the public note.", pillar: null, basedOn: refK ? [refK] : [] },
        { title: "E2E idea two", angle: "From a theme.", pillar: null, basedOn: refT ? [refT] : [] },
        { title: "E2E idea three", angle: "An opinion.", pillar: "Onboarding", basedOn: [] },
        { title: "E2E idea four", angle: "Zelda Quill asked about it.", pillar: null, basedOn: [] },
        { title: "E2E idea five", angle: "Another opinion.", pillar: null, basedOn: [] },
      ];
      const text = JSON.stringify({ ideas: list });
      input.accept(text);
      return { text, provider: "fake", model: "fake/e2e-model" };
    };
    const ideas = await runInOrganization(orgA.id, () => suggestPostIdeas({ includeThemes: true }, { complete: fakeThemes, completeIdeas: fakeIdeas, skipOpenRouterCheck: true }));
    const ideaSent = ideaPrompts.at(-1)!;
    check(ideaSent.userPrompt.includes("E2E-PUBLIC-MARKER") && !ideaSent.userPrompt.includes("E2E-PRIVATE-MARKER") && !ideaSent.userPrompt.includes("E2E-END-OF-CASE"), "ideas read only Knowledge marked public");
    check(ideaSent.systemPrompt.includes("E2E-NEVER-MARKER"), "ideas follow the brief");
    check(ideas.themes > 0 && ideas.withheld === 1 && ideas.ideas.length === 4, "an idea naming the prospect is held back", ideas);
    const themeIdea = ideas.ideas.find((idea) => idea.source.kind === "conversations");
    const opened = themeIdea ? await call(a, "POST", "/api/linkedin/posts", { linkedinAccountId: acc.id, body: "", source: themeIdea.source }) : null;
    check(opened?.status === 201, "an idea from a theme opens as a draft with its sealed source", opened?.json);

    const learned = await runInOrganization(orgA.id, () =>
      learnAuthorVoice(acc.id, {
        complete: async (input) => {
          const text = JSON.stringify({ sound: "- I keep it short.", format: "", language: "", phrases: "", topics: "" });
          input.accept(text);
          return { text, provider: "fake", model: "fake/e2e-model" };
        },
      }),
    );
    const [voiceAfterLearn] = await sql<{ instructions: unknown }[]>`select instructions from linkedin_author_voices where linkedin_account_id = ${acc.id}`;
    check(learned.postsRead === 2 && learned.instructions[0]?.title === "How I sound" && JSON.stringify(voiceAfterLearn.instructions).includes("E2E-VOICE-MARKER"), "Learn from my posts reads the account's own posts and saves nothing", learned);

    // ------------------------------------------------------- organization B
    console.log("\nB: a second organization, Unipile connected, one account of its own");
    const stamp = Date.now();
    const email = `posts-b+${stamp}@example.test`;
    const password = "posts-b-password-1";
    const signUp = await authPost("/sign-up/email", { name: "Posts B", email, password });
    if (!signUp.ok) throw new Error(`B sign-up failed (${signUp.status}) ${await signUp.text()} — start the server with AUTH_SIGNUP=open`);
    await sql`update users set email_verified = true where email = ${email}`;
    let b = await signIn(email, password, "B");
    const created = await authPost("/organization/create", { name: `Posts B ${stamp}`, slug: `posts-b-${stamp}` }, b.cookie);
    if (!created.ok) throw new Error(`B org create failed (${created.status}) ${await created.text()}`);
    const orgB = ((await created.json()) as { id: string }).id;
    await connectUnipile(orgB);
    const [accB] = await sql<{ id: string }[]>`
      insert into "LinkedInAccount" ("organizationId", id, "linkedinId", username, name, status, "updatedAt")
      values (${orgB}, ${`posts-b-${stamp}`}, ${`unipile-b-${stamp}`}, ${`posts-b-${stamp}`}, 'B Person', 'CONNECTED', now())
      returning id`;
    b = await signIn(email, password, "B");

    const aRows = await sql<{ id: string }[]>`select id from linkedin_posts where organization_id = ${orgA.id}`;
    const aIds = aRows.map((row) => row.id);
    const draftA = (await sql<{ id: string }[]>`select id from linkedin_posts where organization_id = ${orgA.id} and status = 'draft' limit 1`)[0].id;
    const callsBeforeB = mockCalls.length;

    const listB = await call(b, "GET", "/api/linkedin/posts?pageSize=100");
    check(listB.status === 200, "B lists its posts", listB.status);
    check(!aIds.some((id) => listB.text.includes(id)), "B's list contains none of A's posts");
    check(JSON.stringify(listB.json.counts) === JSON.stringify({ draft: 0, scheduled: 0, publishing: 0, published: 0, failed: 0 }) && listB.json.total === 0, "B's counts include nothing of A's", listB.json.counts);
    const listByAccount = await call(b, "GET", `/api/linkedin/posts?account=${acc.id}`);
    check(listByAccount.json.total === 0 && !aIds.some((id) => listByAccount.text.includes(id)), "filtering by A's account shows B nothing");

    const before = await snapshot(draftA);
    const attempts: [string, string, unknown?][] = [
      ["GET", `/api/linkedin/posts/${draftA}`],
      ["PATCH", `/api/linkedin/posts/${draftA}`, { body: "B was here" }],
      ["PATCH", `/api/linkedin/posts/${draftA}`, { linkedinAccountId: accB.id }],
      ["POST", `/api/linkedin/posts/${draftA}/publish`],
      ["DELETE", `/api/linkedin/posts/${draftA}`],
      ["GET", `/api/linkedin/posts/${draftA}/images/00000000-0000-4000-8000-000000000000`],
      ["DELETE", `/api/linkedin/posts/${draftA}/images/00000000-0000-4000-8000-000000000000`],
    ];
    for (const [method, url, body] of attempts) {
      const res = await call(b, method, url, body);
      check(res.status === 404 && !res.text.includes("e2e test"), `B: ${method} ${url.replace(draftA, "<A's post>")} → 404`, `${res.status} ${res.text.slice(0, 160)}`);
    }
    const imageB = new FormData();
    imageB.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], "x.png", { type: "image/png" }));
    const uploadB = await call(b, "POST", `/api/linkedin/posts/${draftA}/images`, imageB);
    check(uploadB.status === 404 || uploadB.status === 409, "B cannot upload an image to A's post", `${uploadB.status} ${uploadB.text.slice(0, 120)}`);
    check((await snapshot(draftA)) === before, "A's post is byte-identical after B's attempts");
    check(mockCalls.length === callsBeforeB, "none of B's attempts reached Unipile");

    // A page with loading.tsx streams, so notFound() arrives after a 200: check what it rendered.
    const [{ body: draftBody }] = await sql<{ body: string }[]>`select body from linkedin_posts where id = ${draftA}`;
    const pageB = await call(b, "GET", `/linkedin/posts/${draftA}`);
    check(
      /NEXT_HTTP_ERROR_FALLBACK;404/.test(pageB.text) && !pageB.text.includes(draftBody) && !pageB.text.includes(acc.name),
      "B opening A's post page renders not-found, with none of the post or its account",
      pageB.status,
    );

    const stealAccount = await call(b, "POST", "/api/linkedin/posts", { linkedinAccountId: acc.id, body: "Posting as A's person" });
    check(stealAccount.status === 400, "B cannot create a post on A's account", stealAccount.json);
    check((await sql`select 1 from linkedin_posts where linkedin_account_id = ${acc.id} and organization_id = ${orgB}`).length === 0, "no row was created for A's account in B");

    // Phase 2: B cannot draft with A's account or A's Knowledge.
    const voiceBeforeB = voiceCalls.length;
    const bGenAccount = await call(b, "POST", "/api/linkedin/posts/generate", { linkedinAccountId: acc.id, topic: "Posting as A" });
    check(bGenAccount.status === 400 && !bGenAccount.text.includes(acc.name), "B cannot generate drafts with A's account", bGenAccount.json);
    const bRewriteAccount = await call(b, "POST", "/api/linkedin/posts/rewrite", { linkedinAccountId: acc.id, body: "Text", instruction: "shorter" });
    check(bRewriteAccount.status === 400, "B cannot rewrite with A's account", bRewriteAccount.json);
    const bGenKnowledge = await call(b, "POST", "/api/linkedin/posts/generate", { linkedinAccountId: accB.id, knowledgeDocumentIds: [caseId] });
    check(bGenKnowledge.status === 400 && !bGenKnowledge.text.includes("E2E case study"), "B cannot generate from A's Knowledge", bGenKnowledge.json);
    const bRewriteKnowledge = await call(b, "POST", "/api/linkedin/posts/rewrite", { linkedinAccountId: accB.id, body: "Text", instruction: "shorter", knowledgeDocumentIds: [caseId] });
    check(bRewriteKnowledge.status === 400, "B cannot rewrite with A's Knowledge", bRewriteKnowledge.json);
    const bGenOwn = await call(b, "POST", "/api/linkedin/posts/generate", { linkedinAccountId: accB.id, topic: "Our own topic" });
    check(bGenOwn.status === 409, "B's own account and topic get as far as the OpenRouter check (409: B has none)", bGenOwn.json);
    check(voiceCalls.length === voiceBeforeB, "none of B's attempts read anyone's LinkedIn posts", voiceCalls.slice(voiceBeforeB));
    const bSaveSource = await call(b, "POST", "/api/linkedin/posts", { linkedinAccountId: accB.id, body: "x", source: { kind: "knowledge", knowledgeDocumentIds: [caseId] } });
    check(bSaveSource.status === 400, "B cannot save a post whose source names A's Knowledge", bSaveSource.json);

    const promptsBeforeB = prompts.length;
    const inB = (fn: () => Promise<unknown>) => runInOrganization(orgB, fn).then(() => 200, (error: { status?: number }) => error.status ?? 500);
    check((await inB(() => draftPosts({ linkedinAccountId: acc.id, topic: "x", knowledgeDocumentIds: [] }, deps(["A", "B", "C"])))) === 400, "in B's scope, drafting with A's account is refused");
    check((await inB(() => draftPosts({ linkedinAccountId: accB.id, topic: null, knowledgeDocumentIds: [caseId] }, deps(["A", "B", "C"])))) === 400, "in B's scope, drafting from A's Knowledge is refused");
    check((await inB(() => rewritePostDraft({ linkedinAccountId: acc.id, topic: null, knowledgeDocumentIds: [], body: "x", instruction: "y" }, deps(["Z"])))) === 400, "in B's scope, rewriting with A's account is refused");
    check(prompts.length === promptsBeforeB, "no completion ran for any refused draft");
    await runInOrganization(orgB, () => draftPosts({ linkedinAccountId: accB.id, topic: "B's topic", knowledgeDocumentIds: [] }, deps(["A", "B", "C"])));
    check(prompts.length === promptsBeforeB + 1 && !prompts.at(-1)!.userPrompt.includes("E2E-PUBLIC-MARKER"), "B's own draft runs, and carries none of A's Knowledge");

    // Phase 4: B reads none of A's prospects and cannot use A's theme.
    const bThemePrompts = themePrompts.length;
    const bThemes = await runInOrganization(orgB, () => postThemes({ complete: fakeThemes, skipOpenRouterCheck: true }));
    check(bThemes.read === 0 && bThemes.themes.length === 0 && themePrompts.length === bThemePrompts, "B's themes read none of A's replies or calls (no model call)", bThemes);
    const bUseTheme = await call(b, "POST", "/api/linkedin/posts/generate", { linkedinAccountId: accB.id, theme: picked });
    check(bUseTheme.status === 400 && !bUseTheme.text.includes(picked.summary), "B cannot draft from A's theme", bUseTheme.json);
    const bSaveTheme = await call(b, "POST", "/api/linkedin/posts", { linkedinAccountId: accB.id, body: "x", source: themeSource });
    check(bSaveTheme.status === 400, "B cannot save a post with A's conversations source", bSaveTheme.json);
    const bThemesRoute = await call(b, "POST", "/api/linkedin/posts/themes", {});
    check(bThemesRoute.status === 409, "B's themes route stops at the OpenRouter check", bThemesRoute.json);

    // Phase 5: B cannot read or change A's brief or voices, and carries none of them.
    const bInstructions = await call(b, "GET", "/api/crm/settings/ai-instructions");
    check(!bInstructions.text.includes("E2E-NEVER-MARKER") && bInstructions.json.postInstructionsCustomized !== true, "B's Instructions show the default brief, none of A's", bInstructions.json.postInstructionsCustomized);
    const bBriefPut = await call(b, "PUT", "/api/crm/settings/ai-instructions", { pipelineId: pipelineA, postInstructions: [{ id: "x", title: "B", content: "B was here" }] });
    check(bBriefPut.status >= 400 && bBriefPut.status < 500, "B cannot write A's brief through A's pipeline id", bBriefPut.status);
    const [briefAfterB] = await sql<{ post_instructions: unknown }[]>`select post_instructions from crm_settings where pipeline_id = ${pipelineA}`;
    check(JSON.stringify(briefAfterB.post_instructions).includes("E2E-NEVER-MARKER") && !JSON.stringify(briefAfterB.post_instructions).includes("B was here"), "A's brief is unchanged after B's attempt");
    for (const [method, url, body] of [
      ["GET", `/api/linkedin/posts/voices/${acc.id}`],
      ["PUT", `/api/linkedin/posts/voices/${acc.id}`, { instructions: [{ id: "sound", title: "x", content: "B was here" }] }],
      ["POST", `/api/linkedin/posts/voices/${acc.id}/learn`],
    ] as [string, string, unknown?][]) {
      const res = await call(b, method, url, body);
      check(res.status === 404 && !res.text.includes("E2E-VOICE-MARKER"), `B: ${method} ${url.replace(acc.id, "<A's account>")} → 404`, `${res.status} ${res.text.slice(0, 120)}`);
    }
    const [voiceAfterB] = await sql<{ instructions: unknown; n: number }[]>`select instructions, (select count(*)::int from linkedin_author_voices where organization_id = ${orgB}) as n from linkedin_author_voices where linkedin_account_id = ${acc.id}`;
    check(JSON.stringify(voiceAfterB.instructions).includes("E2E-VOICE-MARKER") && voiceAfterB.n === 0, "A's voice is unchanged and B has no voice rows", voiceAfterB);
    const bOwnVoice = await call(b, "PUT", `/api/linkedin/posts/voices/${accB.id}`, { instructions: [{ id: "sound", title: "How I sound", content: "B's own voice" }] });
    check(bOwnVoice.status === 200, "B saves a voice for its own account", bOwnVoice.status);
    const promptsBeforeB5 = prompts.length;
    await runInOrganization(orgB, () => draftPosts({ linkedinAccountId: accB.id, topic: "B again", knowledgeDocumentIds: [] }, deps(["A", "B", "C"])));
    const bSystem = prompts.at(-1)!.systemPrompt;
    check(prompts.length === promptsBeforeB5 + 1 && !bSystem.includes("E2E-NEVER-MARKER") && !bSystem.includes("E2E-VOICE-MARKER") && bSystem.includes("B's own voice"), "B's draft has B's voice and the default brief, none of A's");
    const bIdeas = await runInOrganization(orgB, () => suggestPostIdeas({ includeThemes: true }, { complete: fakeThemes, completeIdeas: fakeIdeas, skipOpenRouterCheck: true }));
    const bIdeaSent = ideaPrompts.at(-1)!;
    check(bIdeas.themes === 0 && !bIdeaSent.userPrompt.includes("E2E-PUBLIC-MARKER") && !bIdeaSent.systemPrompt.includes("E2E-NEVER-MARKER"), "B's ideas read none of A's Knowledge, themes or brief", bIdeas);
    const bIdeasRoute = await call(b, "POST", "/api/linkedin/posts/ideas", {});
    check(bIdeasRoute.status === 409, "B's ideas route stops at the OpenRouter check", bIdeasRoute.json);

    // Positive control: B's own draft works and publishes through its own account.
    const own = await call(b, "POST", "/api/linkedin/posts", { linkedinAccountId: accB.id, body: "B's own post" });
    check(own.status === 201, "B creates a draft on its own account", own.json);
    const ownPublish = await call(b, "POST", `/api/linkedin/posts/${(own.json.post as PostJson).id}/publish`);
    check((ownPublish.json.post as PostJson)?.status === "published" && mockCalls.at(-1)?.accountId === `unipile-b-${stamp}`, "B publishes its own post from its own account", ownPublish.json);
    const listA = await call(a, "GET", "/api/linkedin/posts?pageSize=100");
    check(!listA.text.includes((own.json.post as PostJson).id), "A's list does not show B's post");
  } finally {
    await removeE2eKnowledge(orgA.id).catch((error) => console.error("could not remove the E2E Knowledge", error));
    if (savedBrief?.pipelineId) await sql`update crm_settings set post_instructions = ${savedBrief.postInstructions === null ? null : sql.json(savedBrief.postInstructions as never)} where pipeline_id = ${savedBrief.pipelineId}`;
    if (prospect) {
      await sql`delete from call_sessions where id = ${prospect.callId}`;
      await sql`delete from people where id = ${prospect.personId}`;
      await sql`delete from companies where id = ${prospect.companyId}`;
    }
    if (savedByok) await sql`update grid_providers set config = ${sql.json(savedByok as never)} where organization_id = ${orgA.id} and key = 'openrouter-byok-settings'`;
    if (savedUnipile) await sql`update grid_provider_credentials set encrypted_payload = ${savedUnipile.payload} where provider_id = ${savedUnipile.id}`;
    if (savedR2) await sql`update grid_providers set enabled = ${savedR2.enabled} where organization_id = ${orgA.id} and key = 'platform-r2'`;
    mock.close();
    await sql.end();
  }

  console.log(`\n${checks - failures.length}/${checks} checks pass; ${mockCalls.length} calls reached the mock Unipile.`);
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  // The app's own pool (imported for the in-process drafting checks) would keep the process alive.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
