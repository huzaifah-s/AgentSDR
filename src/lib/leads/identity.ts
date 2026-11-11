import { normalizeDomainForTargeting } from "@/lib/qualification/domain";

const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "proton.me", "protonmail.com",
]);

export function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

export function normalizeLinkedinSlug(value: string | null | undefined): string | null {
  let normalized = value?.trim().toLowerCase().replace(/\/$/, "") ?? "";
  if (!normalized) return null;
  try { normalized = decodeURIComponent(normalized); } catch { /* keep the provider value intact */ }
  const match = normalized.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)/i);
  if (match?.[1]) return match[1].trim() || null;
  // Leading "-" and "_" are legal in a vanity slug ("-dhruvkhanna"); rejecting
  // them made a bare slug fail where the same value inside a /in/ URL passed.
  return /^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/iu.test(normalized) ? normalized : null;
}

export type LinkedinApiHint = "sales_navigator" | "recruiter";

export function normalizeLinkedinApiHint(value: unknown): LinkedinApiHint | null {
  return value === "sales_navigator" || value === "recruiter" ? value : null;
}

/**
 * Preserve the identifier used to resolve a LinkedIn search result. Unlike a
 * canonical public slug, this may be an opaque provider id or an encoded URL.
 */
export function normalizeLinkedinSourceIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\/+$/, "") ?? "";
  return normalized || null;
}

export function inferLinkedinApi(value: string | null | undefined): LinkedinApiHint | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  if (normalized.includes("sales.linkedin.com") || normalized.includes("/sales/")) return "sales_navigator";
  if (normalized.includes("recruiter.linkedin.com") || normalized.includes("/talent/")) return "recruiter";
  return null;
}

/** Exact unresolved-provider identity. The API namespace is part of the key. */
export function linkedinSourceIdentityKey(
  value: string | null | undefined,
  api: unknown,
): string | null {
  const source = normalizeLinkedinSourceIdentifier(value);
  if (!source) return null;
  const namespace = normalizeLinkedinApiHint(api) ?? inferLinkedinApi(source) ?? "linkedin";
  return `source:${namespace}:${source.toLowerCase()}`;
}

/** Must stay shared by raw-conflict audit and backfill. Email wins exactly as upsertPerson does. */
export function legacyPersonIdentityKey(input: {
  email?: string | null;
  linkedinUrl?: string | null;
}): string | null {
  const email = normalizeEmail(input.email);
  if (email) return `email:${email}`;
  const linkedin = normalizeLinkedinSlug(input.linkedinUrl);
  return linkedin ? `linkedin:${linkedin}` : null;
}

/** Extract the value Unipile's GET /users/{identifier} endpoint expects. */
export function linkedinLookupIdentifier(value: string): string {
  const source = normalizeLinkedinSourceIdentifier(value);
  if (!source) throw new Error("LinkedIn resolution identifier is empty");
  try {
    const url = new URL(source.includes("://") ? source : `https://${source}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const inIndex = parts.findIndex((part) => part.toLowerCase() === "in");
    const salesLeadIndex = parts.findIndex((part, index) => part.toLowerCase() === "lead" && parts[index - 1]?.toLowerCase() === "sales");
    const recruiterProfileIndex = parts.findIndex((part) => part.toLowerCase() === "profile");
    const candidate = inIndex >= 0
      ? parts[inIndex + 1]
      : salesLeadIndex >= 0
        ? parts[salesLeadIndex + 1]
        : recruiterProfileIndex >= 0
          ? parts[recruiterProfileIndex + 1]
          : parts.at(-1);
    if (candidate) return decodeURIComponent(candidate);
  } catch {
    // Opaque provider identifiers are valid inputs and need no URL parsing.
  }
  return source;
}

/**
 * A LinkedIn member URN — the opaque provider id search results carry, which
 * turns up bare ("ACoAAAtuUW0…") and dressed as a public URL
 * ("linkedin.com/in/ACoAAAtuUW0…") alike. It is not a vanity slug and must
 * never be stored as a person's public LinkedIn identity.
 */
const MEMBER_URN_PATTERN = /^AC[A-Za-z0-9_-]{20,}$/;

/**
 * The canonical public slug a source identifier already carries, or null when
 * it is opaque. Lets profile resolution keep a lead whose slug we searched with
 * is itself the answer, without inventing one for a member URN or a Sales
 * Navigator / Recruiter id.
 */
export function publicSlugFromSourceIdentifier(value: string | null | undefined): string | null {
  const source = normalizeLinkedinSourceIdentifier(value);
  if (!source) return null;
  if (inferLinkedinApi(source)) return null;
  if (MEMBER_URN_PATTERN.test(linkedinLookupIdentifier(source))) return null;
  return normalizeLinkedinSlug(source);
}

export function normalizeCompanyDomain(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return normalizeDomainForTargeting(value) || null;
}

const HOSTNAME_PATTERN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

/**
 * A domain typed by a person — a company's identity, so "Acme Inc" must not
 * become the company `acme inc`. normalizeCompanyDomain() accepts anything,
 * because imports and LinkedIn already hand it real hosts; the manual paths
 * check with this first. Returns the normalized domain, or null.
 */
export function parseCompanyDomain(value: string | null | undefined): string | null {
  const domain = normalizeCompanyDomain(value);
  return domain && HOSTNAME_PATTERN.test(domain) ? domain : null;
}

export function inferCompanyDomainFromEmail(value: string | null | undefined): string | null {
  const email = normalizeEmail(value);
  const domain = email?.split("@")[1] ?? null;
  return domain && !PUBLIC_EMAIL_DOMAINS.has(domain) ? domain : null;
}
