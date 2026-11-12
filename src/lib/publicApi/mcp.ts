import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiScope } from "./access";
import { CRM_ACTION_GROUPS } from "@/lib/crm/actionGroups";
import type {
  ActionRequiredResult,
  AddLeadsResult,
  CampaignDetail,
  CampaignLeadsResult,
  ListCampaignsResult,
  StopLeadsResult,
} from "./operations";
import {
  DEFAULT_ACTIONS_PER_PAGE,
  MAX_ACTIONS_PER_PAGE,
  MAX_EMAILS_PER_LOOKUP,
  MAX_EMAILS_PER_STOP,
  MAX_LEADS_PER_REQUEST,
  PublicApiError,
} from "./requests";

/**
 * The public API as MCP tools, served at /api/v1/mcp
 * (src/app/api/v1/mcp/route.ts, docs/mcp.mdx). Each tool is one operation
 * of src/lib/publicApi/operations.ts, the same one its REST route calls, so
 * the rules and the response are the same through either door.
 *
 * The operations come in as an argument, so this file stays free of the
 * database and its tests run against stubs.
 *
 * A tool is registered only when the caller's scopes allow it
 * (src/lib/publicApi/access.ts): a read-only key does not see the write
 * tools, rather than seeing tools that always fail.
 *
 * The zod input schemas are there for the client and the model to read.
 * They do not decide what is valid: the operations parse their input again
 * with requests.ts, which is the authority. Lead objects are loose for that
 * reason. A strict object would drop a misspelt field before requests.ts
 * could refuse it, and the lead would go out without it.
 */

export type PublicApiOperations = {
  listCampaigns(): Promise<ListCampaignsResult>;
  getCampaignDetail(campaignId: string): Promise<CampaignDetail>;
  getCampaignLeads(campaignId: string, emails: unknown): Promise<CampaignLeadsResult>;
  listActionRequired(query: { group?: unknown; limit?: unknown; offset?: unknown }): Promise<ActionRequiredResult>;
  addLeads(campaignId: string, body: unknown): Promise<AddLeadsResult>;
  stopLeads(campaignId: string, body: unknown): Promise<StopLeadsResult>;
};

export const MCP_SERVER_NAME = "agentsdr";

function instructions(scopes: ReadonlySet<ApiScope>): string {
  const canWrite = scopes.has("campaigns:write");
  return [
    canWrite
      ? "Works with one organization's email campaigns in BraintreeSDR: see them and their leads, add leads, and stop a lead's sequence."
      : "Reads one organization's email campaigns in BraintreeSDR. This connection is read-only: it cannot add or stop leads.",
    scopes.has("campaigns:read") ? "Call list_campaigns first to find a campaign's id." : "",
    scopes.has("crm:read") ? "list_action_required shows the CRM queue of leads waiting on a person: replies to review, follow-ups due, problems." : "",
    canWrite
      ? "Adding leads follows the same rules as a sheet import: suppressed addresses and leads already in the campaign are skipped, and the result counts each."
      : "",
  ].filter(Boolean).join(" ");
}

const LEAD_STATUS_HELP =
  "status: pending (not emailed yet), initial_sent / in_follow_up (in the sequence), reply_processing / reply_received (they replied), sequence_completed (every step sent, or stopped), bounced, suppressed.";

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

const campaignDetailOutput = {
  ...campaignSummarySchema.shape,
  steps: z.number().describe("Steps in the sequence"),
  leads: z.object({
    total: z.number(),
    pending: z.number().describe("Not emailed yet"),
    inSequence: z.number().describe("Emailed, with steps still to go"),
    replied: z.number(),
    completed: z.number().describe("Every step sent, or stopped"),
    bounced: z.number(),
    suppressed: z.number(),
  }),
  emails: z.object({ sent: z.number(), scheduled: z.number(), failed: z.number() }),
};

const campaignLeadsOutput = {
  leads: z.array(
    z.object({
      email: z.string(),
      status: z.string(),
      emailsSent: z.number(),
      lastSentAt: z.string().nullable(),
      nextSendAt: z.string().nullable(),
      addedAt: z.string().nullable(),
    }),
  ),
  notFound: z.array(z.string()).describe("Emails that are not leads of this campaign"),
};

const actionRequiredOutput = {
  items: z.array(
    z.object({
      recordId: z.string(),
      person: z.object({ name: z.string().nullable(), email: z.string().nullable(), company: z.string().nullable() }),
      channel: z.string().nullable(),
      action: z.string().describe("What to do, e.g. Reply review, Due follow-up"),
      group: z.string().nullable(),
      groupLabel: z.string().nullable(),
      dueAt: z.string().nullable(),
      category: z.string().nullable(),
      latestReply: z.object({ at: z.string().nullable(), excerpt: z.string() }).nullable(),
      draft: z.object({ status: z.string(), channel: z.string(), subject: z.string().nullable() }).nullable(),
    }),
  ),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  nextOffset: z.number().nullable().describe("Pass as offset for the next page; null on the last page"),
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

/** A server with the tools `scopes` allow. Build one per request: the endpoint is stateless. */
export function buildMcpServer(ops: PublicApiOperations, scopes: ReadonlySet<ApiScope>): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, title: "BraintreeSDR", version: "1.0.0" }, { instructions: instructions(scopes) });

  if (scopes.has("campaigns:read")) server.registerTool(
    "list_campaigns",
    {
      title: "List email campaigns",
      description: "The organization's email campaigns, newest first, with each one's id, name, status and creation time.",
      outputSchema: { campaigns: z.array(campaignSummarySchema) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run("list_campaigns", () => ops.listCampaigns()),
  );

  if (scopes.has("campaigns:read")) server.registerTool(
    "get_campaign",
    {
      title: "Get a campaign",
      description: "One email campaign with its numbers: leads by status (pending, in sequence, replied, completed, bounced, suppressed) and emails sent, scheduled and failed.",
      inputSchema: { campaignId },
      outputSchema: campaignDetailOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ campaignId }) => run("get_campaign", () => ops.getCampaignDetail(campaignId)),
  );

  if (scopes.has("campaigns:read")) server.registerTool(
    "get_campaign_leads",
    {
      title: "Look up leads in a campaign",
      description: `Where up to ${MAX_EMAILS_PER_LOOKUP} people stand in an email campaign, by email: their status, emails sent, the last and next send. ${LEAD_STATUS_HELP}`,
      inputSchema: {
        campaignId,
        emails: z.array(z.string()).min(1).max(MAX_EMAILS_PER_LOOKUP).describe("The leads' email addresses"),
      },
      outputSchema: campaignLeadsOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ campaignId, emails }) => run("get_campaign_leads", () => ops.getCampaignLeads(campaignId, emails)),
  );

  if (scopes.has("crm:read")) server.registerTool(
    "list_action_required",
    {
      title: "List CRM Action required",
      description: [
        "The CRM's Action required queue, newest activity first: leads waiting on a person, with what to do, the channel, when it is due and the first lines of their latest reply.",
        `Pages of up to ${MAX_ACTIONS_PER_PAGE} (default ${DEFAULT_ACTIONS_PER_PAGE}); pass nextOffset back as offset for the next page.`,
      ].join(" "),
      inputSchema: {
        group: z.enum(CRM_ACTION_GROUPS).optional().describe("reply (immediate reply), follow_up (follow-up due), classification (confirm classification), next_step (needs a next step), problem (error or failed)"),
        limit: z.number().int().min(1).max(MAX_ACTIONS_PER_PAGE).optional(),
        offset: z.number().int().min(0).optional(),
      },
      outputSchema: actionRequiredOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (query) => run("list_action_required", () => ops.listActionRequired(query)),
  );

  if (scopes.has("campaigns:write")) server.registerTool(
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

  if (scopes.has("campaigns:write")) server.registerTool(
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
