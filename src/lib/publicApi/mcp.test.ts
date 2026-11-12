import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { currentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { scopesForKeyAccess } from "./access";
import { buildMcpServer, toolError, toolResult, type PublicApiOperations } from "./mcp";
import { PublicApiError, campaignIdParam, parseActionRequiredQuery, parseLeadsRequest, parseLookupEmails, parseStopRequest } from "./requests";

const CAMPAIGN = "0b6a3c1e-1111-4222-8333-444455556666";

/**
 * Stand-ins for operations.ts that keep its input rules (requests.ts) and
 * record what they were given, without a database.
 */
function stubOperations(overrides: Partial<PublicApiOperations> = {}) {
  const calls: { op: string; campaignId?: string; body?: unknown }[] = [];
  const ops: PublicApiOperations = {
    async listCampaigns() {
      calls.push({ op: "listCampaigns" });
      return { campaigns: [{ id: CAMPAIGN, name: "Launch", status: "active", createdAt: "2026-11-05T09:30:00.000Z" }] };
    },
    async getCampaignDetail(campaignId) {
      calls.push({ op: "getCampaignDetail", campaignId });
      campaignIdParam(campaignId);
      return {
        id: campaignId, name: "Launch", status: "active", createdAt: null, steps: 3,
        leads: { total: 2, pending: 1, inSequence: 1, replied: 0, completed: 0, bounced: 0, suppressed: 0 },
        emails: { sent: 1, scheduled: 1, failed: 0 },
      };
    },
    async getCampaignLeads(campaignId, emails) {
      calls.push({ op: "getCampaignLeads", campaignId, body: emails });
      campaignIdParam(campaignId);
      const wanted = parseLookupEmails(emails);
      return { leads: [], notFound: wanted };
    },
    async listActionRequired(query) {
      calls.push({ op: "listActionRequired", body: query });
      const { limit, offset } = parseActionRequiredQuery(query);
      return { items: [], total: 0, limit, offset, nextOffset: null };
    },
    async addLeads(campaignId, body) {
      calls.push({ op: "addLeads", campaignId, body });
      campaignIdParam(campaignId);
      const rows = parseLeadsRequest(body);
      return { total: rows.length, imported: rows.length, skippedSuppressed: 0, skippedDuplicate: 0, failed: [] };
    },
    async stopLeads(campaignId, body) {
      calls.push({ op: "stopLeads", campaignId, body });
      campaignIdParam(campaignId);
      return { stopped: parseStopRequest(body).length, alreadyEnded: 0, notFound: [] };
    },
    ...overrides,
  };
  return { ops, calls };
}

const READ_WRITE = scopesForKeyAccess("read_write");

async function connect(ops: PublicApiOperations, scopes = READ_WRITE) {
  const server = buildMcpServer(ops, scopes);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as CallToolResult).content;
  const first = content[0];
  return first && first.type === "text" ? first.text : "";
}

let consoleError: ReturnType<typeof spyOn>;
beforeEach(() => {
  consoleError = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

describe("tool results", () => {
  test("a result carries the body as structured content and as text", () => {
    const result = toolResult({ stopped: 1 });
    expect(result.structuredContent).toEqual({ stopped: 1 });
    expect(JSON.parse(textOf(result))).toEqual({ stopped: 1 });
    expect(result.isError).toBeUndefined();
  });

  test("a caller's mistake comes back with its message", () => {
    const result = toolError(new PublicApiError(404, "Campaign not found"), "t");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Campaign not found");
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("a server error is logged and its details are hidden", () => {
    const result = toolError(new Error('relation "outreach_leads" does not exist'), "t");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Something went wrong on the server");
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("MCP server", () => {
  test("a read-and-write key lists every tool, with their annotations", async () => {
    const client = await connect(stubOperations().ops);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(byName).sort()).toEqual([
      "add_leads_to_campaign", "get_campaign", "get_campaign_leads", "list_action_required", "list_campaigns", "stop_campaign_leads",
    ]);
    for (const name of ["get_campaign", "get_campaign_leads", "list_action_required"]) expect(byName[name].annotations?.readOnlyHint).toBe(true);
    expect(byName.list_campaigns.annotations?.readOnlyHint).toBe(true);
    expect(byName.add_leads_to_campaign.annotations?.destructiveHint).toBe(false);
    expect(byName.stop_campaign_leads.annotations?.destructiveHint).toBe(true);
    expect(byName.stop_campaign_leads.annotations?.idempotentHint).toBe(true);
    expect(byName.add_leads_to_campaign.inputSchema.required).toEqual(["campaignId", "leads"]);
  });

  test("a read-only key sees only the read tools, and is told it is read-only", async () => {
    const client = await connect(stubOperations().ops, scopesForKeyAccess("read"));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["get_campaign", "get_campaign_leads", "list_action_required", "list_campaigns"]);
    expect(client.getInstructions()).toContain("read-only");
    const result = await client.callTool({ name: "add_leads_to_campaign", arguments: { campaignId: CAMPAIGN, leads: [{ email: "a@example.com" }] } });
    expect(result.isError).toBe(true);
  });

  test("only the CRM tool for a token with crm:read alone", async () => {
    const client = await connect(stubOperations().ops, new Set(["crm:read"] as const));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["list_action_required"]);
  });

  test("get_campaign returns the campaign's numbers", async () => {
    const client = await connect(stubOperations().ops);
    const result = await client.callTool({ name: "get_campaign", arguments: { campaignId: CAMPAIGN } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ id: CAMPAIGN, steps: 3, leads: { total: 2 } });
  });

  test("get_campaign_leads hands the emails to the operation", async () => {
    const { ops, calls } = stubOperations();
    const client = await connect(ops);
    const result = await client.callTool({ name: "get_campaign_leads", arguments: { campaignId: CAMPAIGN, emails: ["A@Example.com"] } });
    expect(calls).toEqual([{ op: "getCampaignLeads", campaignId: CAMPAIGN, body: ["A@Example.com"] }]);
    expect(result.structuredContent).toEqual({ leads: [], notFound: ["a@example.com"] });
  });

  test("list_action_required passes its filters, and an unknown group is refused", async () => {
    const { ops, calls } = stubOperations();
    const client = await connect(ops);
    const result = await client.callTool({ name: "list_action_required", arguments: { group: "reply", limit: 5 } });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ op: "listActionRequired", body: { group: "reply", limit: 5 } }]);
    expect(result.structuredContent).toEqual({ items: [], total: 0, limit: 5, offset: 0, nextOffset: null });
    const bad = await client.callTool({ name: "list_action_required", arguments: { group: "everything" } });
    expect(bad.isError).toBe(true);
  });

  test("list_campaigns returns the operation's body", async () => {
    const client = await connect(stubOperations().ops);
    const result = await client.callTool({ name: "list_campaigns", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      campaigns: [{ id: CAMPAIGN, name: "Launch", status: "active", createdAt: "2026-11-05T09:30:00.000Z" }],
    });
  });

  test("add_leads_to_campaign hands the leads to the operation as the REST body", async () => {
    const { ops, calls } = stubOperations();
    const client = await connect(ops);
    const lead = { email: "maker@example.com", firstName: "Asha", customFields: { productName: "Example", seats: 3 } };
    const result = await client.callTool({ name: "add_leads_to_campaign", arguments: { campaignId: CAMPAIGN, leads: [lead] } });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ op: "addLeads", campaignId: CAMPAIGN, body: { leads: [lead] } }]);
    expect(result.structuredContent).toMatchObject({ total: 1, imported: 1 });
  });

  test("a misspelt lead field reaches requests.ts and is refused, not dropped", async () => {
    const client = await connect(stubOperations().ops);
    const result = await client.callTool({
      name: "add_leads_to_campaign",
      arguments: { campaignId: CAMPAIGN, leads: [{ email: "maker@example.com", frstName: "Asha" }] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("leads[0].frstName is not a lead field");
  });

  test("an id that is not a campaign's is Campaign not found", async () => {
    const client = await connect(stubOperations().ops);
    const result = await client.callTool({ name: "stop_campaign_leads", arguments: { campaignId: "nope", emails: ["a@example.com"] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Campaign not found");
  });

  test("stop_campaign_leads hands the emails to the operation", async () => {
    const { ops, calls } = stubOperations();
    const client = await connect(ops);
    const result = await client.callTool({ name: "stop_campaign_leads", arguments: { campaignId: CAMPAIGN, emails: ["A@Example.com"] } });
    expect(calls).toEqual([{ op: "stopLeads", campaignId: CAMPAIGN, body: { emails: ["A@Example.com"] } }]);
    expect(result.structuredContent).toEqual({ stopped: 1, alreadyEnded: 0, notFound: [] });
  });

  test("an empty leads list is refused before the operation runs", async () => {
    const { ops, calls } = stubOperations();
    const client = await connect(ops);
    const result = await client.callTool({ name: "add_leads_to_campaign", arguments: { campaignId: CAMPAIGN, leads: [] } });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("an operation's server error is hidden from the model", async () => {
    const { ops } = stubOperations({
      async listCampaigns() {
        throw new Error("password authentication failed for user postgres");
      },
    });
    const client = await connect(ops);
    const result = await client.callTool({ name: "list_campaigns", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Something went wrong on the server");
  });
});

describe("HTTP transport inside an organization scope", () => {
  // What the route does: one server and transport per request, run inside
  // the scope withApiKey opens. The tools must see that organization, or
  // every inOrg() query in operations.ts would throw. This is the test that
  // notices if an SDK upgrade starts running handlers outside the request's
  // async context.
  test("a tool called over HTTP runs in the request's organization", async () => {
    const seen: string[] = [];
    const { ops } = stubOperations({
      async listCampaigns() {
        seen.push(currentOrganizationId());
        return { campaigns: [] };
      },
    });

    async function post(body: unknown): Promise<Response> {
      const server = buildMcpServer(ops, READ_WRITE);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        const request = new Request("http://localhost/api/v1/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify(body),
        });
        return await runInOrganization("org-a", () => transport.handleRequest(request));
      } finally {
        await server.close();
      }
    }

    const call = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_campaigns", arguments: {} } });
    expect(call.status).toBe(200);
    expect(call.headers.get("content-type")).toContain("application/json");
    const json = (await call.json()) as { result: CallToolResult };
    expect(json.result.isError).toBeFalsy();
    expect(json.result.structuredContent).toEqual({ campaigns: [] });
    expect(seen).toEqual(["org-a"]);
  });
});
