import { and, eq, ne, sql } from "drizzle-orm";
import { companies, people } from "./schema";
import { inferCompanyDomainFromEmail, normalizeEmail, normalizeLinkedinSlug, parseCompanyDomain } from "./identity";
import { lockIdentities, resolvePersonNames, upsertCompany, withLeadTransaction } from "./records";
import { inOrg } from "@/lib/tenancy/scope";
import { normalizePhone } from "@/lib/calls/phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";

/** The Leads page's Edit person form: every field, as it should now be ("" clears). */
export type PersonEditInput = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  phone?: string | null;
  title?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  notes?: string | null;
};

export class PersonEditError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

const clean = (value: string | null | undefined) => value?.trim() || null;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates an edit. Stricter than an import row, because a person typed it
 * about one record: a phone number that does not parse is refused rather than
 * dropped (dropping would erase the old one), and the person must keep an
 * email or LinkedIn identity, as every Person does.
 *
 * The company follows upsertPerson's rules: a company is its domain — the one
 * given, else the work email's when only a name is — and without one the name
 * stays on the person as text.
 */
export function normalizePersonEdit(input: PersonEditInput, phoneCountry?: string) {
  const email = normalizeEmail(input.email);
  const linkedinUrl = normalizeLinkedinSlug(input.linkedinUrl);
  if (clean(input.email) && !email) throw new PersonEditError(400, `Invalid email address: ${input.email}`);
  if (clean(input.linkedinUrl) && !linkedinUrl) throw new PersonEditError(400, `Invalid LinkedIn profile URL: ${input.linkedinUrl}`);
  if (!email && !linkedinUrl) throw new PersonEditError(400, "A person needs an email address or a LinkedIn URL");

  const phone = clean(input.phone) ? normalizePhone(input.phone as string, phoneCountry) : null;
  if (clean(input.phone) && !phone) throw new PersonEditError(400, `Invalid phone number: ${input.phone} (include the country code, e.g. +91)`);

  const companyName = clean(input.companyName);
  const typedDomain = clean(input.companyDomain);
  const typedParsed = typedDomain ? parseCompanyDomain(typedDomain) : null;
  if (typedDomain && !typedParsed) throw new PersonEditError(400, `Invalid company domain: ${typedDomain} (expected something like acme.com)`);
  const companyDomain = typedParsed ?? (companyName ? inferCompanyDomainFromEmail(email) : null);

  return {
    email,
    linkedinUrl,
    phone,
    firstName: clean(input.firstName),
    lastName: clean(input.lastName),
    title: clean(input.title),
    companyName,
    companyDomain,
    notes: clean(input.notes),
  };
}

/**
 * Replaces one Person's fields with the form's, in the organization in scope.
 * The same guards as calling's Edit contact (`updateCampaignContact`): an
 * email or LinkedIn profile another person holds is a 409, not a merge, and
 * the company is linked or created through upsertCompany by domain. CRM
 * records, campaigns and messages keep pointing at the same person id.
 */
export async function updatePerson(personId: string, input: PersonEditInput) {
  if (!UUID_SHAPE.test(personId)) throw new PersonEditError(404, "Person not found");
  const next = normalizePersonEdit(input, await organizationPhoneCountry());

  return withLeadTransaction(async (tx) => {
    await lockIdentities(tx, [
      next.email ? `person:email:${next.email}` : "",
      next.linkedinUrl ? `person:linkedin:${next.linkedinUrl}` : "",
    ].filter(Boolean));

    const [existing] = await tx.select().from(people).where(and(inOrg(people), eq(people.id, personId))).limit(1).for("update");
    if (!existing) throw new PersonEditError(404, "Person not found");

    if (next.email && next.email !== normalizeEmail(existing.email)) {
      const [conflict] = await tx.select({ id: people.id }).from(people)
        .where(and(inOrg(people), sql`lower(${people.email}) = ${next.email}`, ne(people.id, personId))).limit(1);
      if (conflict) throw new PersonEditError(409, "Another person already has this email address");
    }
    if (next.linkedinUrl && next.linkedinUrl !== normalizeLinkedinSlug(existing.linkedinUrl)) {
      const [conflict] = await tx.select({ id: people.id }).from(people)
        .where(and(inOrg(people), eq(people.linkedinUrl, next.linkedinUrl), ne(people.id, personId))).limit(1);
      if (conflict) throw new PersonEditError(409, "Another person already has this LinkedIn profile");
    }

    const { company: _company, companyName: _companyName, companyDomain: _companyDomain, notes: _notes, ...rawRest } = existing.raw ?? {};
    void _company; void _companyName; void _companyDomain; void _notes;
    const company = next.companyDomain
      ? await upsertCompany(tx, { name: next.companyName, domain: next.companyDomain, source: "manual" })
      : null;
    const raw: Record<string, unknown> = {
      ...rawRest,
      ...(!company && next.companyName ? { company: next.companyName, companyName: next.companyName } : {}),
      ...(next.notes ? { notes: next.notes } : {}),
    };

    const names = resolvePersonNames({ firstName: next.firstName, lastName: next.lastName }, existing, { replaceExisting: true });
    // An identity the form only re-spelled (case, a URL around the same slug)
    // keeps its stored value, so an edit never rewrites what LinkedIn sends
    // and campaigns match on.
    const sameEmail = next.email !== null && next.email === normalizeEmail(existing.email);
    const sameLinkedin = next.linkedinUrl !== null && next.linkedinUrl === normalizeLinkedinSlug(existing.linkedinUrl);
    const [updated] = await tx.update(people).set({
      email: sameEmail ? existing.email : next.email,
      linkedinUrl: sameLinkedin ? existing.linkedinUrl : next.linkedinUrl,
      phone: next.phone,
      title: next.title,
      ...names,
      companyId: company?.id ?? null,
      raw,
      updatedAt: new Date(),
    }).where(and(inOrg(people), eq(people.id, personId))).returning();

    const [linked] = updated.companyId
      ? await tx.select({ name: companies.name, domain: companies.domain }).from(companies)
        .where(and(inOrg(companies), eq(companies.id, updated.companyId))).limit(1)
      : [];
    return { person: updated, company: linked ?? null };
  });
}
