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
