/**
 * The MCP endpoint (/api/v1/mcp), end to end, through the SDK's own HTTP client:
 *
 *   BASE_URL=http://localhost:3110 bun run scripts/e2e/mcp-smoke.ts
 *
 * Runs against a RUNNING server and its database (DATABASE_URL), and refuses
 * a non-local DATABASE_URL. It works only on its own data, so it can run on a
 * development database and can be re-run: two organizations upserted by slug
 * (mcp-smoke-a, mcp-smoke-b), a draft campaign in A (drafts never send), and
 * one API key per organization per run, revoked at the end. Leads get a
 * fresh @example.test address each run.
 *
 * Checks: every tool is listed for a read-and-write key; A's key sees A's
 * campaign, adds leads (a second identical call skips them as duplicates),
 * reads the campaign's numbers and the leads' status, and stops one (stopping
 * it again is "already ended"); Action required answers; a read-only key sees
 * only the read tools and its REST writes are 403; B's key does not see A's
 * campaign, and reading, adding to or stopping in it is "Campaign not found";
 * a revoked key is refused; GET is 405.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import postgres from "postgres";
import { createApiKeySecret } from "@/lib/publicApi/token";

const BASE = process.env.BASE_URL ?? "http://localhost:3110";
const ENDPOINT = new URL("/api/v1/mcp", BASE);

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local database.");
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL!, { ssl: false, max: 2, onnotice: () => {} });

const failures: string[] = [];
function check(ok: boolean, what: string, detail?: unknown) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures.push(detail === undefined ? what : `${what}: ${JSON.stringify(detail)}`);
}

async function organization(slug: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES (${`MCP smoke ${slug.slice(-1).toUpperCase()}`}, ${slug})
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id`;
  return row.id;
}

async function draftCampaign(organizationId: string): Promise<string> {
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM outreach_campaigns WHERE organization_id = ${organizationId} AND name = 'MCP smoke' LIMIT 1`;
  if (existing) return existing.id;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO outreach_campaigns (organization_id, name, status) VALUES (${organizationId}, 'MCP smoke', 'draft') RETURNING id`;
  return row.id;
}

async function apiKey(organizationId: string, access: "read" | "read_write" = "read_write"): Promise<{ key: string; id: string }> {
  const { key, hash, prefix } = createApiKeySecret();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO api_keys (organization_id, name, key_prefix, key_hash, access)
    VALUES (${organizationId}, 'mcp-smoke', ${prefix}, ${hash}, ${access}) RETURNING id`;
  return { key, id: row.id };
}

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: "mcp-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(ENDPOINT, { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  return { result, text: first?.type === "text" ? first.text : "", data: result.structuredContent as Record<string, unknown> | undefined };
}

async function main() {
  const orgA = await organization("mcp-smoke-a");
  const orgB = await organization("mcp-smoke-b");
  const campaign = await draftCampaign(orgA);
  const keyA = await apiKey(orgA);
  const keyB = await apiKey(orgB);
  const readA = await apiKey(orgA, "read");
  const run = Date.now();
  const emails = [`mcp-smoke-${run}-1@example.test`, `mcp-smoke-${run}-2@example.test`];

  try {
    console.log(`MCP smoke against ${ENDPOINT}`);
    const a = await connect(keyA.key);

    const { tools } = await a.listTools();
    const everyTool = ["add_leads_to_campaign", "get_campaign", "get_campaign_leads", "list_action_required", "list_campaigns", "stop_campaign_leads"];
    check(JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify(everyTool), "lists every tool", tools.map((t) => t.name));

    const listA = await call(a, "list_campaigns", {});
    const campaignsA = (listA.data?.campaigns ?? []) as { id: string }[];
    check(!listA.result.isError && campaignsA.some((c) => c.id === campaign), "A's key sees A's campaign", listA.text);

    const leads = emails.map((email, i) => ({ email, firstName: `Smoke${i + 1}`, customFields: { run: String(run) } }));
    const added = await call(a, "add_leads_to_campaign", { campaignId: campaign, leads });
    check(!added.result.isError && added.data?.imported === 2, "A adds two leads", added.text);

    const again = await call(a, "add_leads_to_campaign", { campaignId: campaign, leads });
    check(!again.result.isError && again.data?.imported === 0 && again.data?.skippedDuplicate === 2, "adding them again skips both as duplicates", again.text);

    const misspelt = await call(a, "add_leads_to_campaign", { campaignId: campaign, leads: [{ email: emails[0], frstName: "x" }] });
    check(misspelt.result.isError === true && misspelt.text.includes("frstName is not a lead field"), "a misspelt field is refused by name", misspelt.text);

    const detail = await call(a, "get_campaign", { campaignId: campaign });
    const detailLeads = detail.data?.leads as { total?: number; pending?: number } | undefined;
    check(!detail.result.isError && (detailLeads?.total ?? 0) >= 2 && detail.data?.status === "draft", "get_campaign counts the leads", detail.text);

    const statuses = await call(a, "get_campaign_leads", { campaignId: campaign, emails: [emails[0].toUpperCase(), "nobody@example.test"] });
    const found = (statuses.data?.leads ?? []) as { email: string; status: string; emailsSent: number }[];
    check(
      !statuses.result.isError && found.length === 1 && found[0].email === emails[0] && found[0].status === "pending" && found[0].emailsSent === 0
        && JSON.stringify(statuses.data?.notFound) === JSON.stringify(["nobody@example.test"]),
      "get_campaign_leads finds a lead whatever the case, and reports an unknown email",
      statuses.text,
    );

    const actions = await call(a, "list_action_required", { limit: 5 });
    check(!actions.result.isError && Array.isArray(actions.data?.items) && actions.data?.limit === 5, "list_action_required answers", actions.text);

    const stopped = await call(a, "stop_campaign_leads", { campaignId: campaign, emails: [emails[0], "nobody@example.test"] });
    check(
      !stopped.result.isError && stopped.data?.stopped === 1 && JSON.stringify(stopped.data?.notFound) === JSON.stringify(["nobody@example.test"]),
      "A stops one lead; an unknown email is notFound",
      stopped.text,
    );

    const stoppedAgain = await call(a, "stop_campaign_leads", { campaignId: campaign, emails: [emails[0]] });
    check(!stoppedAgain.result.isError && stoppedAgain.data?.alreadyEnded === 1, "stopping it again is already ended", stoppedAgain.text);

    const afterStop = await call(a, "get_campaign_leads", { campaignId: campaign, emails: [emails[0]] });
    const stoppedLead = ((afterStop.data?.leads ?? []) as { status: string }[])[0];
    check(stoppedLead?.status === "sequence_completed", "a stopped lead reads as sequence_completed", afterStop.text);
    await a.close();

    const ro = await connect(readA.key);
    const roTools = (await ro.listTools()).tools.map((t) => t.name).sort();
    check(
      JSON.stringify(roTools) === JSON.stringify(["get_campaign", "get_campaign_leads", "list_action_required", "list_campaigns"]),
      "a read-only key sees only the read tools",
      roTools,
    );
    const roAdd = await call(ro, "add_leads_to_campaign", { campaignId: campaign, leads: [{ email: `mcp-smoke-${run}-ro@example.test` }] });
    check(roAdd.result.isError === true, "a read-only key cannot call a write tool", roAdd.text);
    await ro.close();

    const rest = (path: string, key: string, init: RequestInit = {}) =>
      fetch(new URL(`/api/v1${path}`, BASE), { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
    const roRestAdd = await rest(`/campaigns/${campaign}/leads`, readA.key, { method: "POST", body: JSON.stringify({ leads: [{ email: `mcp-smoke-${run}-ro@example.test` }] }) });
    check(roRestAdd.status === 403, "a read-only key's REST add is 403", `${roRestAdd.status} ${await roRestAdd.text()}`);
    const roRestStop = await rest(`/campaigns/${campaign}/leads/stop`, readA.key, { method: "POST", body: JSON.stringify({ emails: [emails[1]] }) });
    check(roRestStop.status === 403, "a read-only key's REST stop is 403", roRestStop.status);
    const roRestGet = await rest(`/campaigns/${campaign}`, readA.key);
    check(roRestGet.status === 200, "a read-only key reads the campaign over REST", roRestGet.status);
    const roRestLeads = await rest(`/campaigns/${campaign}/leads?email=${encodeURIComponent(emails[1])}`, readA.key);
    const roRestLeadsBody = (await roRestLeads.json()) as { leads?: { status: string }[] };
    check(roRestLeads.status === 200 && roRestLeadsBody.leads?.[0]?.status === "pending", "REST lead lookup", roRestLeadsBody);
    const roRestActions = await rest(`/crm/action-required?limit=3`, readA.key);
    check(roRestActions.status === 200, "REST Action required", roRestActions.status);
    const badGroup = await rest(`/crm/action-required?group=everything`, readA.key);
    check(badGroup.status === 400, "REST Action required refuses an unknown group", badGroup.status);

    const b = await connect(keyB.key);
    const listB = await call(b, "list_campaigns", {});
    check(!listB.result.isError && !listB.text.includes(campaign), "B's key does not see A's campaign", listB.text);

    const addB = await call(b, "add_leads_to_campaign", { campaignId: campaign, leads: [{ email: `mcp-smoke-${run}-b@example.test` }] });
    check(addB.result.isError === true && addB.text === "Campaign not found", "B cannot add leads to A's campaign", addB.text);

    const stopB = await call(b, "stop_campaign_leads", { campaignId: campaign, emails: [emails[1]] });
    check(stopB.result.isError === true && stopB.text === "Campaign not found", "B cannot stop A's leads", stopB.text);

    const getB = await call(b, "get_campaign", { campaignId: campaign });
    check(getB.result.isError === true && getB.text === "Campaign not found", "B cannot read A's campaign", getB.text);

    const leadsB = await call(b, "get_campaign_leads", { campaignId: campaign, emails: [emails[1]] });
    check(leadsB.result.isError === true && leadsB.text === "Campaign not found", "B cannot look up A's leads", leadsB.text);
    await b.close();

    const [lead] = await sql<{ status: string }[]>`
      SELECT l.sequence_status AS status FROM outreach_leads l JOIN people p ON p.id = l.person_id
      WHERE l.campaign_id = ${campaign} AND p.email = ${emails[1]}`;
    check(lead?.status === "pending", "B's attempt left A's second lead untouched", lead?.status ?? "no such lead");

    await sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${keyA.id}`;
    const revoked = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${keyA.key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    check(revoked.status === 401, "a revoked key is refused (401)", revoked.status);

    const get = await fetch(ENDPOINT, { headers: { authorization: `Bearer ${keyB.key}`, accept: "text/event-stream" } });
    check(get.status === 405, "GET is 405 (stateless)", get.status);
  } finally {
    await sql`UPDATE api_keys SET revoked_at = now() WHERE id IN (${keyA.id}, ${keyB.id}, ${readA.id}) AND revoked_at IS NULL`;
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
