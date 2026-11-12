/**
 * OAuth for the MCP endpoint, end to end over HTTP, the way an MCP client
 * such as a claude.ai connector does it:
 *
 *   BASE_URL=http://localhost:3110 bun run --conditions=react-server scripts/e2e/mcp-oauth.ts
 *
 * The server under test must run with BETTER_AUTH_URL equal to BASE_URL (the
 * OAuth issuer and the MCP resource are built from it). Refuses a non-local
 * DATABASE_URL. Works only on its own data and can be re-run: the
 * mcp-smoke-a / mcp-smoke-b organizations (see mcp-smoke.ts) and a test user,
 * mcp-oauth@example.test, upserted with a fresh random password each run and
 * made a member of both.
 *
 * Checks: discovery (protected resource and authorization server metadata,
 * and the 401's resource_metadata); dynamic client registration; sign-in;
 * authorize sends a two-organization member to /oauth/organization, then
 * consent; consent without write access; code exchange with PKCE and the
 * resource; the token sees only the read tools and only its organization;
 * refresh; leaving the organization cuts the token off; disconnecting in
 * Settings revokes the access and refresh tokens; a made-up token is 401;
 * client management from a session is refused.
 */
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

const BASE = process.env.BASE_URL ?? "http://localhost:3110";
const MCP = new URL("/api/v1/mcp", BASE).toString();
const REDIRECT_URI = "http://127.0.0.1:53682/callback";
const EMAIL = "mcp-oauth@example.test";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local database.");
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL!, { ssl: false, max: 2, onnotice: () => {} });

const failures: string[] = [];
function check(ok: boolean, what: string, detail?: unknown) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures.push(detail === undefined ? what : `${what}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

// ---------------------------------------------------------------- fixtures

async function organization(slug: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES (${`MCP smoke ${slug.slice(-1).toUpperCase()}`}, ${slug})
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
  return row.id;
}

async function draftCampaign(organizationId: string, name: string): Promise<string> {
  const [existing] = await sql<{ id: string }[]>`SELECT id FROM outreach_campaigns WHERE organization_id = ${organizationId} AND name = ${name} LIMIT 1`;
  if (existing) return existing.id;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO outreach_campaigns (organization_id, name, status) VALUES (${organizationId}, ${name}, 'draft') RETURNING id`;
  return row.id;
}

/** The test user, with a new password each run, a member of both organizations. */
async function testUser(password: string, organizationIds: string[]): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (name, email, email_verified) VALUES ('MCP OAuth test', ${EMAIL}, true)
    ON CONFLICT (email) DO UPDATE SET email_verified = true RETURNING id`;
  const hash = await hashPassword(password);
  const [account] = await sql<{ id: string }[]>`SELECT id FROM accounts WHERE user_id = ${user.id} AND provider_id = 'credential' LIMIT 1`;
  if (account) await sql`UPDATE accounts SET password = ${hash} WHERE id = ${account.id}`;
  else await sql`INSERT INTO accounts (account_id, provider_id, user_id, password) VALUES (${user.id}, 'credential', ${user.id}, ${hash})`;
  for (const organizationId of organizationIds) {
    await sql`
      INSERT INTO members (organization_id, user_id, role)
      SELECT ${organizationId}, ${user.id}, 'member'
      WHERE NOT EXISTS (SELECT 1 FROM members WHERE organization_id = ${organizationId} AND user_id = ${user.id})`;
  }
  return user.id;
}

// ---------------------------------------------------------------- http

function cookiesFrom(res: Response, previous = ""): string {
  const jar = new Map(previous.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as const));
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0];
    jar.set(pair.split("=")[0], pair);
  }
  return [...jar.values()].join("; ");
}

async function authPost(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie, accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

/** What oauthProviderClient sends as `oauth_query`: the signed parameters of a page's URL. */
function signedQuery(url: string): string {
  const params = new URL(url, BASE).searchParams;
  const names = new Set(params.getAll("ba_param"));
  const out = new URLSearchParams();
  for (const [key, value] of params.entries()) if (key === "sig" || key === "ba_param" || names.has(key)) out.append(key, value);
  return out.toString();
}

async function mcpStatus(token: string): Promise<number> {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return res.status;
}

async function tokenRequest(endpoint: string, form: Record<string, string>) {
  const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

// ---------------------------------------------------------------- run

async function main() {
  const orgA = await organization("mcp-smoke-a");
  const orgB = await organization("mcp-smoke-b");
  const campaignA = await draftCampaign(orgA, "MCP smoke");
  const campaignB = await draftCampaign(orgB, "MCP smoke B");
  const password = randomBytes(18).toString("base64url");
  const userId = await testUser(password, [orgA, orgB]);

  try {
    console.log(`MCP OAuth against ${BASE}`);

    // Discovery, as an MCP client does it from a 401.
    const unauthenticated = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    const challenge = unauthenticated.headers.get("www-authenticate") ?? "";
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
    check(unauthenticated.status === 401 && metadataUrl.endsWith("/.well-known/oauth-protected-resource/api/v1/mcp"), "a 401 names the resource metadata", challenge);

    const resourceMeta = (await (await fetch(new URL(new URL(metadataUrl).pathname, BASE)).catch(() => fetch(metadataUrl))).json()) as {
      resource: string; authorization_servers: string[]; scopes_supported: string[];
    };
    check(resourceMeta.resource === MCP && resourceMeta.scopes_supported.includes("campaigns:write"), "protected resource metadata", resourceMeta);
    const issuer = resourceMeta.authorization_servers[0];
    const asMetaUrl = new URL(`/.well-known/oauth-authorization-server${new URL(issuer).pathname}`, BASE);
    const asMeta = (await (await fetch(asMetaUrl)).json()) as Record<string, unknown>;
    check(asMeta.issuer === issuer && typeof asMeta.registration_endpoint === "string", "authorization server metadata at the issuer's path", asMeta);
    const bare = await fetch(new URL("/.well-known/oauth-authorization-server", BASE));
    check(bare.status === 200, "and at the bare well-known path", bare.status);
    const endpoint = (key: string) => new URL(new URL(String(asMeta[key])).pathname, BASE).toString();

    // Dynamic client registration, unauthenticated, as a public client.
    const registered = await fetch(endpoint("registration_endpoint"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP OAuth e2e",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    const client = (await registered.json()) as { client_id?: string };
    check(registered.status === 200 || registered.status === 201, "a client registers itself", client);
    const clientId = client.client_id!;

    // Sign in.
    const signIn = await authPost("/sign-in/email", { email: EMAIL, password }, "");
    let cookie = cookiesFrom(signIn);
    check(signIn.ok, "the test user signs in", signIn.status);

    // Session-based client management is refused for everyone.
    const create = await authPost("/oauth2/create-client", { redirect_uris: [REDIRECT_URI], skip_consent: true }, cookie);
    check(create.status >= 400, "creating a client from a session is refused", create.status);

    // Authorize: a member of two organizations chooses one first.
    const verifier = randomBytes(32).toString("base64url");
    const challengeS256 = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(8).toString("hex");
    const authorize = new URL(endpoint("authorization_endpoint"));
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "campaigns:read campaigns:write crm:read offline_access",
      state,
      code_challenge: challengeS256,
      code_challenge_method: "S256",
      resource: MCP,
    })) authorize.searchParams.set(key, value);
    const toOrg = await fetch(authorize, { headers: { cookie }, redirect: "manual" });
    const orgPage = toOrg.headers.get("location") ?? "";
    check(toOrg.status >= 300 && toOrg.status < 400 && orgPage.includes("/oauth/organization") && orgPage.includes("sig="), "authorize sends a two-organization member to choose", `${toOrg.status} ${orgPage}`);

    const orgHtml = await fetch(new URL(orgPage, BASE), { headers: { cookie } });
    const orgHtmlText = await orgHtml.text();
    check(orgHtml.status === 200 && orgHtmlText.includes("MCP smoke A") && orgHtmlText.includes("MCP smoke B"), "the organization page lists both", orgHtml.status);

    // Start on B, as if the person last worked there, so choosing A is a real switch.
    const onB = await authPost("/organization/set-active", { organizationId: orgB }, cookie);
    cookie = cookiesFrom(onB, cookie);
    const chosen = await fetch(`${BASE}/api/oauth/organization`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ organizationId: orgA }),
    });
    cookie = cookiesFrom(chosen, cookie);
    check(chosen.ok, "choosing A switches to it and is recorded", chosen.status);
    const notMine = await fetch(`${BASE}/api/oauth/organization`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "00000000-0000-4000-8000-000000000000" }),
    });
    check(notMine.status === 403, "an organization they are not in is refused", notMine.status);
    const continued = await authPost("/oauth2/continue", { postLogin: true, oauth_query: signedQuery(orgPage) }, cookie);
    const continuedBody = (await continued.json()) as { url?: string };
    const consentPage = continuedBody.url ?? "";
    check(continued.ok && consentPage.includes("/oauth/consent"), "choosing organization A continues to consent", continuedBody);

    const consentHtml = await fetch(new URL(consentPage, BASE), { headers: { cookie } });
    const consentText = await consentHtml.text();
    check(consentHtml.status === 200 && consentText.includes("MCP OAuth e2e") && consentText.includes("MCP smoke A"), "the consent page names the app and the organization", consentHtml.status);

    // Consent to reading only.
    const consent = await authPost("/oauth2/consent", { accept: true, scope: "campaigns:read crm:read offline_access", oauth_query: signedQuery(consentPage) }, cookie);
    const consentBody = (await consent.json()) as { url?: string };
    const back = new URL(consentBody.url ?? "about:blank");
    const code = back.searchParams.get("code") ?? "";
    check(consent.ok && back.origin + back.pathname === REDIRECT_URI && back.searchParams.get("state") === state && Boolean(code), "consent returns a code to the client", consentBody);

    // Exchange the code; PKCE is checked.
    const wrongVerifier = await tokenRequest(endpoint("token_endpoint"), {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: randomBytes(32).toString("base64url"), resource: MCP,
    });
    check(wrongVerifier.status >= 400, "a wrong PKCE verifier is refused", wrongVerifier);
    // The code may be spent by the failed attempt; get a fresh one through the
    // same consent (already given for exactly these scopes, so authorize
    // answers with a code at once). Asking for write again would go back to
    // consent, since the person did not allow it.
    const reauthorize = new URL(authorize);
    reauthorize.searchParams.set("scope", "campaigns:read crm:read offline_access");
    const again = await fetch(reauthorize, { headers: { cookie }, redirect: "manual" });
    const againLocation = again.headers.get("location") ?? "";
    const code2 = new URL(againLocation, BASE).searchParams.get("code") ?? "";
    check(Boolean(code2) && againLocation.startsWith(REDIRECT_URI), "a second authorization reuses the consent", `${again.status} ${againLocation}`);
    const exchanged = await tokenRequest(endpoint("token_endpoint"), {
      grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: MCP,
    });
    const accessToken = String(exchanged.body.access_token ?? "");
    const refreshToken = String(exchanged.body.refresh_token ?? "");
    check(exchanged.status === 200 && Boolean(accessToken) && Boolean(refreshToken), "the code exchanges for access and refresh tokens", { status: exchanged.status, scope: exchanged.body.scope, error: exchanged.body.error });

    // Use it.
    const mcp = new Client({ name: "mcp-oauth-e2e", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
    check(JSON.stringify(tools) === JSON.stringify(["get_campaign", "get_campaign_leads", "list_action_required", "list_campaigns"]), "a read-only consent gets only the read tools", tools);
    const list = await mcp.callTool({ name: "list_campaigns", arguments: {} });
    const listed = JSON.stringify(list.structuredContent ?? {});
    check(!list.isError && listed.includes(campaignA) && !listed.includes(campaignB), "the token sees organization A only", listed.slice(0, 200));
    const readB = await mcp.callTool({ name: "get_campaign", arguments: { campaignId: campaignB } });
    check(readB.isError === true, "B's campaign is not found through A's token", readB.content);
    await mcp.close();

    // Refresh.
    const refreshed = await tokenRequest(endpoint("token_endpoint"), { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: MCP });
    const refreshedAccess = String(refreshed.body.access_token ?? "");
    check(refreshed.status === 200 && Boolean(refreshedAccess) && (await mcpStatus(refreshedAccess)) === 200, "a refreshed token works", { status: refreshed.status, error: refreshed.body.error });
    const latestRefresh = String(refreshed.body.refresh_token ?? refreshToken);

    // Leaving the organization cuts the token off at once.
    await sql`DELETE FROM members WHERE organization_id = ${orgA} AND user_id = ${userId}`;
    check((await mcpStatus(refreshedAccess)) === 401, "removed from the organization: 401");
    await sql`INSERT INTO members (organization_id, user_id, role) VALUES (${orgA}, ${userId}, 'member')`;
    check((await mcpStatus(refreshedAccess)) === 200, "a member again: works again");

    // Disconnect in Settings.
    const [consentRow] = await sql<{ id: string }[]>`SELECT id FROM oauth_consents WHERE client_id = ${clientId} AND user_id = ${userId} LIMIT 1`;
    const disconnect = await fetch(`${BASE}/api/settings/connected-apps/${consentRow?.id}`, { method: "DELETE", headers: { cookie, origin: BASE } });
    check(disconnect.status === 200, "Settings disconnects the app", disconnect.status);
    check((await mcpStatus(refreshedAccess)) === 401, "a disconnected app's access token is 401");
    const refreshAfter = await tokenRequest(endpoint("token_endpoint"), { grant_type: "refresh_token", refresh_token: latestRefresh, client_id: clientId, resource: MCP });
    check(refreshAfter.status >= 400, "and its refresh token no longer works", refreshAfter);

    check((await mcpStatus(randomBytes(24).toString("base64url"))) === 401, "a made-up token is 401");
  } finally {
    await sql.end();
  }

  if (failures.length) {
    console.error(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
