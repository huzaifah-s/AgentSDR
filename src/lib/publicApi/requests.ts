import { CRM_ACTION_GROUPS, isCrmActionGroup, type CrmActionGroup } from "@/lib/crm/actionGroups";
import { migrationMutationBlockReason } from "@/lib/migration/controls";
import type { ParsedRow } from "@/lib/outreach/leadImport";

/**
 * Reading the public API's request bodies. Pure, so the rules are tested
 * without a database. Each parser throws PublicApiError(400) with a message
 * that names the offending field, because the caller is a developer reading
 * the response, not a person in the UI.
 */

export class PublicApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PublicApiError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A campaign id from the path or a tool's arguments. Anything that is not a uuid is a 404, like an unknown id. */
export function campaignIdParam(id: string): string {
  if (!UUID.test(id)) throw new PublicApiError(404, "Campaign not found");
  return id;
}

/**
 * Refuses a lead import or stop while campaign changes are paused
 * (PAUSE_CAMPAIGN_MUTATIONS, PEOPLE_MIGRATION_MODE). proxy.ts already refuses
 * POSTs under /api/v1/campaigns, but it matches by path, and the MCP tools
 * arrive at /api/v1/mcp. The write operations check it themselves, so the
 * pause holds whichever way the request comes in.
 */
export function assertCampaignWritesAllowed(env: Record<string, string | undefined> = process.env): void {
  const reason = migrationMutationBlockReason("/api/v1/campaigns", "POST", env);
  if (reason) throw new PublicApiError(503, reason);
}

export const MAX_LEADS_PER_REQUEST = 500;
export const MAX_EMAILS_PER_STOP = 500;
const MAX_CUSTOM_FIELDS = 50;
const MAX_VALUE_LENGTH = 2000;
/** A merge field name: `{{productName}}`. */
const CUSTOM_FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The lead fields a request may send, besides customFields. */
const LEAD_FIELDS = {
  email: true,
  firstName: true,
  lastName: true,
  title: true,
  company: true,
  companyDomain: true,
  companyLinkedinUrl: true,
  linkedinUrl: true,
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PublicApiError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_VALUE_LENGTH) throw new PublicApiError(400, `${field} is longer than ${MAX_VALUE_LENGTH} characters`);
  return trimmed || null;
}

function customFields(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new PublicApiError(400, `${field} must be an object of field name to value`);
  const entries = Object.entries(value);
  if (entries.length > MAX_CUSTOM_FIELDS) throw new PublicApiError(400, `${field} has more than ${MAX_CUSTOM_FIELDS} fields`);
  const fields: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!CUSTOM_FIELD_KEY.test(key)) {
      throw new PublicApiError(400, `${field}.${key}: a field name starts with a letter and has only letters, digits and _ (it is used as {{${key}}})`);
    }
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      throw new PublicApiError(400, `${field}.${key} must be a string, number or boolean`);
    }
    const rendered = String(raw).trim();
    if (rendered.length > MAX_VALUE_LENGTH) throw new PublicApiError(400, `${field}.${key} is longer than ${MAX_VALUE_LENGTH} characters`);
    if (rendered) fields[key] = rendered;
  }
  return fields;
}

/**
 * `{ leads: [{ email, firstName?, lastName?, title?, company?, companyDomain?,
 * companyLinkedinUrl?, linkedinUrl?, customFields? }] }` as import rows.
 * An unknown key is refused rather than dropped, so a misspelt field is
 * noticed instead of silently missing from the emails. An invalid email is
 * not refused here: the import reports it per lead, as it does for a sheet.
 */
export function parseLeadsRequest(body: unknown): ParsedRow[] {
  if (!isObject(body) || !Array.isArray(body.leads)) throw new PublicApiError(400, "The body must be { \"leads\": [ ... ] }");
  const leads = body.leads;
  if (leads.length === 0) throw new PublicApiError(400, "leads is empty");
  if (leads.length > MAX_LEADS_PER_REQUEST) throw new PublicApiError(400, `At most ${MAX_LEADS_PER_REQUEST} leads per request`);

  return leads.map((lead, index): ParsedRow => {
    const at = `leads[${index}]`;
    if (!isObject(lead)) throw new PublicApiError(400, `${at} must be an object`);
    for (const key of Object.keys(lead)) {
      if (key !== "customFields" && !(key in LEAD_FIELDS)) throw new PublicApiError(400, `${at}.${key} is not a lead field`);
    }
    const field = (key: keyof typeof LEAD_FIELDS) => text(lead[key], `${at}.${key}`);
    return {
      email: (field("email") ?? "").toLowerCase(),
      firstName: field("firstName"),
      lastName: field("lastName"),
      title: field("title"),
      company: field("company"),
      domain: field("companyDomain"),
      companyLinkedinUrl: field("companyLinkedinUrl"),
      linkedinUrl: field("linkedinUrl"),
      customFields: customFields(lead.customFields, `${at}.customFields`),
    };
  });
}

/** `{ emails: ["a@example.com", ...] }`, trimmed and lowercased. */
export function parseStopRequest(body: unknown): string[] {
  if (!isObject(body) || !Array.isArray(body.emails)) throw new PublicApiError(400, "The body must be { \"emails\": [ ... ] }");
  const emails = body.emails;
  if (emails.length === 0) throw new PublicApiError(400, "emails is empty");
  if (emails.length > MAX_EMAILS_PER_STOP) throw new PublicApiError(400, `At most ${MAX_EMAILS_PER_STOP} emails per request`);
  return emails.map((email, index) => {
    if (typeof email !== "string" || !email.trim()) throw new PublicApiError(400, `emails[${index}] must be an email address`);
    return email.trim().toLowerCase();
  });
}

export const MAX_EMAILS_PER_LOOKUP = 100;

/**
 * The addresses to look up in a campaign: `["a@example.com", ...]`, trimmed
 * and lowercased. REST reads them from `?email=` (repeated, or
 * comma-separated); the MCP tool passes its list.
 */
export function parseLookupEmails(emails: unknown): string[] {
  if (!Array.isArray(emails) || emails.length === 0) throw new PublicApiError(400, "Give at least one email (?email=a@example.com)");
  const split = emails.flatMap((email, index) => {
    if (typeof email !== "string") throw new PublicApiError(400, `emails[${index}] must be an email address`);
    return email.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  });
  if (split.length === 0) throw new PublicApiError(400, "Give at least one email (?email=a@example.com)");
  if (split.length > MAX_EMAILS_PER_LOOKUP) throw new PublicApiError(400, `At most ${MAX_EMAILS_PER_LOOKUP} emails per lookup`);
  return split;
}

export const DEFAULT_ACTIONS_PER_PAGE = 20;
export const MAX_ACTIONS_PER_PAGE = 50;

export type ActionRequiredQuery = { group?: CrmActionGroup; limit: number; offset: number };

/** `{ group?, limit?, offset? }` for the Action required queue, from query parameters or tool arguments. */
export function parseActionRequiredQuery(input: { group?: unknown; limit?: unknown; offset?: unknown }): ActionRequiredQuery {
  const group = input.group === undefined || input.group === null || input.group === "" ? undefined : input.group;
  if (group !== undefined && (typeof group !== "string" || !isCrmActionGroup(group))) {
    throw new PublicApiError(400, `group must be one of ${CRM_ACTION_GROUPS.join(", ")}`);
  }
  const limit = wholeNumber(input.limit, "limit", DEFAULT_ACTIONS_PER_PAGE);
  if (limit < 1 || limit > MAX_ACTIONS_PER_PAGE) throw new PublicApiError(400, `limit must be between 1 and ${MAX_ACTIONS_PER_PAGE}`);
  const offset = wholeNumber(input.offset, "offset", 0);
  if (offset < 0) throw new PublicApiError(400, "offset must be 0 or more");
  return { group, limit, offset };
}

function wholeNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(number)) throw new PublicApiError(400, `${field} must be a whole number`);
  return number;
}
