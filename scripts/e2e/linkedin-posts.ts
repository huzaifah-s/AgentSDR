/**
 * LinkedIn posts, end to end, against a RUNNING dev server and a mock Unipile:
 * the publish path (one call per publish, never a retry, refusals and
 * uncertain failures, the daily limit, the stale-publishing sweep) and
 * isolation (a second organization cannot list, open, edit, delete,
 * publish, upload to or count the first one's posts).
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
import { encryptIntegrationCredentials } from "@/lib/integrations/credentials";
import { UNCERTAIN_PUBLISH_ERROR } from "@/lib/linkedin/posts/contract";

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

  // A: Unipile → the mock, R2 off. Kept to restore afterwards.
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

    // Positive control: B's own draft works and publishes through its own account.
    const own = await call(b, "POST", "/api/linkedin/posts", { linkedinAccountId: accB.id, body: "B's own post" });
    check(own.status === 201, "B creates a draft on its own account", own.json);
    const ownPublish = await call(b, "POST", `/api/linkedin/posts/${(own.json.post as PostJson).id}/publish`);
    check((ownPublish.json.post as PostJson)?.status === "published" && mockCalls.at(-1)?.accountId === `unipile-b-${stamp}`, "B publishes its own post from its own account", ownPublish.json);
    const listA = await call(a, "GET", "/api/linkedin/posts?pageSize=100");
    check(!listA.text.includes((own.json.post as PostJson).id), "A's list does not show B's post");
  } finally {
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
