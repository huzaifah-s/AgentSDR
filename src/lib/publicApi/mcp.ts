import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AddLeadsResult, ListCampaignsResult, StopLeadsResult } from "./operations";
import { MAX_EMAILS_PER_STOP, MAX_LEADS_PER_REQUEST, PublicApiError } from "./requests";

/**
 * The public API as MCP tools, served at /api/v1/mcp
 * (src/app/api/v1/mcp/route.ts, docs/mcp.mdx). Each tool is one operation
 * of src/lib/publicApi/operations.ts, the same one its REST route calls, so
 * the rules and the response are the same through either door.
 *
 * The operations come in as an argument, so this file stays free of the
 * database and its tests run against stubs.
 *
 * The zod input schemas are there for the client and the model to read.
 * They do not decide what is valid: the operations parse their input again
 * with requests.ts, which is the authority. Lead objects are loose for that
 * reason. A strict object would drop a misspelt field before requests.ts
 * could refuse it, and the lead would go out without it.
 */

export type PublicApiOperations = {
  listCampaigns(): Promise<ListCampaignsResult>;
  addLeads(campaignId: string, body: unknown): Promise<AddLeadsResult>;
  stopLeads(campaignId: string, body: unknown): Promise<StopLeadsResult>;
};

export const MCP_SERVER_NAME = "agentsdr";

const INSTRUCTIONS = [
  "Works with one organization's email campaigns in BraintreeSDR: list them, add leads, and stop a lead's sequence.",
  "Call list_campaigns first to find a campaign's id.",
  "Adding leads follows the same rules as a sheet import: suppressed addresses and leads already in the campaign are skipped, and the result counts each.",
].join(" ");

const text = z.string().nullish();

const leadSchema = z
  .looseObject({
    email: z.string().describe("The lead's email address. Required."),
    firstName: text,
    lastName: text,
    title: text.describe("Job title"),
    company: text,
    companyDomain: text.describe("The company's website domain, e.g. example.com"),
    companyLinkedinUrl: text,
    linkedinUrl: text.describe("The person's LinkedIn profile URL"),
    customFields: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("Extra merge fields, used in the campaign's emails as {{fieldName}}. A name starts with a letter and has only letters, digits and _."),
  })
  .describe("One lead. Fields other than these are refused.");

const campaignId = z.string().describe("The campaign's id, from list_campaigns");

const campaignSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  createdAt: z.string().nullable(),
});

const addLeadsOutput = {
  total: z.number().describe("Leads in the request"),
  imported: z.number().describe("Leads added to the campaign"),
  skippedSuppressed: z.number().describe("Leads skipped because the address is suppressed (unsubscribed, bounced, Do Not Contact)"),
  skippedDuplicate: z.number().describe("Leads skipped because they are already in the campaign"),
  failed: z
    .array(z.object({ index: z.number(), email: z.string(), error: z.string() }))
    .describe("Leads that could not be added, by their index in the request"),
};

const stopLeadsOutput = {
  stopped: z.number().describe("Leads whose sequence was running and is now ended"),
  alreadyEnded: z.number().describe("Leads whose sequence had already ended"),
  notFound: z.array(z.string()).describe("Emails that are not leads of this campaign"),
};

/** A successful tool result: the REST response body, as structured content and as text. */
export function toolResult(value: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/**
 * A failed tool result. A PublicApiError is the caller's mistake, and its
 * message names the field at fault, so the model can read it and fix the
 * input. Anything else is ours: logged, and hidden behind a generic message.
 * The SDK would otherwise put a thrown error's own message in the result,
 * which could carry SQL or internal details.
 */
export function toolError(error: unknown, tool: string): CallToolResult {
  if (error instanceof PublicApiError) return { content: [{ type: "text", text: error.message }], isError: true };
  console.error("[mcp]", tool, error);
  return { content: [{ type: "text", text: "Something went wrong on the server" }], isError: true };
}

async function run(tool: string, fn: () => Promise<object>): Promise<CallToolResult> {
  try {
    return toolResult(await fn());
  } catch (error) {
    return toolError(error, tool);
  }
}

/** A server with the public API's tools. Build one per request: the endpoint is stateless. */
export function buildMcpServer(ops: PublicApiOperations): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, title: "BraintreeSDR", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_campaigns",
    {
      title: "List email campaigns",
      description: "The organization's email campaigns, newest first, with each one's id, name, status and creation time.",
      outputSchema: { campaigns: z.array(campaignSummarySchema) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run("list_campaigns", () => ops.listCampaigns()),
  );

  server.registerTool(
    "add_leads_to_campaign",
    {
      title: "Add leads to a campaign",
      description: [
        `Adds up to ${MAX_LEADS_PER_REQUEST} leads to an email campaign, which then emails them on its sequence.`,
        "Suppressed addresses and leads already in the campaign are skipped, not added twice, so retrying a call is safe.",
        "Invalid emails are reported per lead in `failed`; the rest are still added.",
      ].join(" "),
      inputSchema: {
        campaignId,
        leads: z.array(leadSchema).min(1).max(MAX_LEADS_PER_REQUEST),
      },
      outputSchema: addLeadsOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ campaignId, leads }) => run("add_leads_to_campaign", () => ops.addLeads(campaignId, { leads })),
  );

  server.registerTool(
    "stop_campaign_leads",
    {
      title: "Stop leads' sequence",
      description: [
        `Ends a campaign's sequence for up to ${MAX_EMAILS_PER_STOP} leads, by email: no further email of this campaign goes to them.`,
        "Use it when a person no longer needs follow-ups, for example they signed up. It does not suppress them, so a later campaign can still reach them.",
        "Stopping a lead twice is harmless.",
      ].join(" "),
      inputSchema: {
        campaignId,
        emails: z.array(z.string()).min(1).max(MAX_EMAILS_PER_STOP).describe("The leads' email addresses"),
      },
      outputSchema: stopLeadsOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ campaignId, emails }) => run("stop_campaign_leads", () => ops.stopLeads(campaignId, { emails })),
  );

  return server;
}
