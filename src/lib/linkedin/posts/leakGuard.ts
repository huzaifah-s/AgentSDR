/**
 * The leak guard (docs/linkedin-content/plan.md, Phase 4): a post written
 * from what prospects said must never name them. Before a draft reaches the
 * rep, and again when a post whose `source.kind` is `conversations` is
 * scheduled or published, its text is checked against the people in the
 * source set: their names, their companies, their email addresses and phone
 * numbers. A match blocks it and says what matched.
 *
 * The same terms also redact the messages before they reach the themes call,
 * so the model is handed as little about anyone as possible.
 *
 * Pure and import-free (tests: leakGuard.test.ts). What it matches, and why:
 *
 * - A full name ("Priya Shah", either order) anywhere, any case.
 * - A surname alone, only written as a name (first letter upper case), and of
 *   at least 3 letters: "Shah" matches, "shah" in a URL slug or "best" for a
 *   Mr Best does not. A first name alone is not matched: it rarely
 *   identifies anyone, and "Will" or "Grace" would block ordinary sentences.
 * - A company's name with its legal suffix taken off ("Zeta Labs Pvt Ltd" →
 *   "Zeta Labs"), the same way; a one-word name only when capitalised.
 *   Its web domain anywhere ("zetalabs.io"), unless it is a mail provider's.
 * - An email address anywhere, any case.
 * - A phone number by its last 8 digits, however the text groups them
 *   ("+91 98765 43210", "98765-43210").
 * - A LinkedIn profile slug of 5 characters or more.
 */

export type LeakPerson = {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
};

export type LeakKind = "name" | "company" | "email" | "phone" | "profile";

type MatchRule =
  /** Anywhere, any case, on word boundaries. */
  | "phrase"
  /** On word boundaries, any case, but only where the match starts with an upper-case letter. */
  | "capitalised"
  /** Digits, however grouped. */
  | "digits";

export type LeakTerm = { kind: LeakKind; value: string; rule: MatchRule };

export type LeakMatch = { kind: LeakKind; value: string };

const MIN_SURNAME = 3;
const MIN_COMPANY = 3;
const MIN_SLUG = 5;
const PHONE_DIGITS = 8;

/** Legal and filler suffixes taken off a company's name before matching. */
const COMPANY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "lp", "ltd", "limited", "corp", "corporation", "co", "company", "plc",
  "pvt", "private", "pte", "sdn", "bhd", "gmbh", "ag", "sa", "sas", "sarl", "srl", "spa", "bv", "nv", "oy", "ab", "as", "kk", "pty",
]);

/** Domains of mail providers: a person's company may be recorded as one, and it names nobody. */
const MAIL_PROVIDER_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "zoho.com", "yandex.com", "mail.com", "rediffmail.com",
]);

/** Folds case-insensitive comparison and diacritics: "José" and "jose" are the same word. */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "");
}

function squash(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function words(value: string): string[] {
  return value.split(/[\s,]+/).map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
}

function letters(value: string): number {
  return value.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

/** "Zeta Labs Pvt. Ltd." → "Zeta Labs". */
export function companyCore(name: string): string {
  const list = words(squash(name));
  while (list.length > 1 && COMPANY_SUFFIXES.has(fold(list[list.length - 1]!).toLowerCase().replace(/\./g, ""))) list.pop();
  return list.join(" ");
}

function domainOf(value: string | null | undefined): string | null {
  const text = squash(value).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(text) ? text : null;
}

function slugOf(value: string | null | undefined): string | null {
  const text = squash(value).replace(/\/+$/, "");
  const slug = text.includes("/") ? text.slice(text.lastIndexOf("/") + 1) : text;
  return slug.length >= MIN_SLUG && /^[\p{L}\p{N}_-]+$/u.test(slug) ? slug : null;
}

/** The terms to look for, from the people in the source set. Duplicates are dropped. */
export function leakTerms(people: readonly LeakPerson[]): LeakTerm[] {
  const terms = new Map<string, LeakTerm>();
  const add = (kind: LeakKind, value: string, rule: MatchRule) => {
    const clean = squash(value);
    if (!clean) return;
    const key = `${rule}:${fold(clean).toLowerCase()}`;
    if (!terms.has(key)) terms.set(key, { kind, value: clean, rule });
  };

  for (const person of people) {
    const first = squash(person.firstName);
    const last = squash(person.lastName);
    const full = squash(person.fullName);
    for (const name of [full, first && last ? `${first} ${last}` : "", first && last ? `${last} ${first}` : ""]) {
      // A one-word "full name" is a first name, which is not matched alone.
      if (name && !name.includes("@") && words(name).length >= 2) add("name", words(name).join(" "), "phrase");
    }
    const surnames = last ? words(last) : full && words(full).length >= 2 ? [words(full).at(-1)!] : [];
    for (const surname of surnames) if (letters(surname) >= MIN_SURNAME) add("name", surname, "capitalised");

    const email = squash(person.email).toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) add("email", email, "phrase");

    const digits = (person.phone ?? "").replace(/\D/g, "");
    if (digits.length >= PHONE_DIGITS) add("phone", digits.slice(-PHONE_DIGITS), "digits");

    const slug = slugOf(person.linkedinUrl);
    if (slug) add("profile", slug, "phrase");

    const company = companyCore(person.companyName ?? "");
    if (letters(company) >= MIN_COMPANY) add("company", company, words(company).length >= 2 ? "phrase" : "capitalised");
    const domain = domainOf(person.companyDomain);
    if (domain && !MAIL_PROVIDER_DOMAINS.has(domain)) add("company", domain, "phrase");
  }
  return [...terms.values()];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The term as a regular expression over folded text, on word boundaries ("Ann" is not in "Annual"). */
function pattern(term: LeakTerm): RegExp {
  const body = words(fold(term.value)).length > 1 && !term.value.includes("@")
    ? words(fold(term.value)).map(escape).join("[\\s\\-.,]+")
    : escape(fold(term.value));
  return new RegExp(`(?<![\\p{L}\\p{N}_@.-])${body}(?![\\p{L}\\p{N}_@]|[.-][\\p{L}\\p{N}])`, "giu");
}

/** Every run of digits in the text, separators between them removed: "+91 98765-43210" → "919876543210". */
function digitRuns(text: string): string[] {
  return (text.match(/\d[\d\s().\-/]*\d/g) ?? []).map((run) => run.replace(/\D/g, ""));
}

function found(text: string, folded: string, term: LeakTerm): string | null {
  if (term.rule === "digits") return digitRuns(text).some((run) => run.includes(term.value)) ? term.value : null;
  for (const match of folded.matchAll(pattern(term))) {
    if (term.rule === "phrase") return match[0];
    if (/^\p{Lu}/u.test(match[0])) return match[0];
  }
  return null;
}

/** What in the text matches the source set. Empty means it is clear. */
export function findLeaks(text: string, terms: readonly LeakTerm[]): LeakMatch[] {
  if (!text.trim() || !terms.length) return [];
  const folded = fold(text);
  const matches: LeakMatch[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    if (!found(text, folded, term)) continue;
    const key = `${term.kind}:${fold(term.value).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ kind: term.kind, value: term.value });
  }
  // A full name also matches as its surname; say it once, as the full name.
  return matches.filter(
    (match) => !(match.kind === "name" && !match.value.includes(" ") && matches.some((other) => other.kind === "name" && other.value.includes(" ") && words(other.value).includes(match.value))),
  );
}

const PLACEHOLDER: Record<LeakKind, string> = {
  name: "[person]",
  company: "[company]",
  email: "[email]",
  phone: "[phone]",
  profile: "[profile]",
};

/**
 * The text with every term replaced by a placeholder, for what is sent to
 * the themes call. Works on folded text, so accents in a name are lost
 * there; that text is only read by the model, never shown or posted.
 */
export function redactLeaks(text: string, terms: readonly LeakTerm[]): string {
  let out = fold(text);
  // Longest first, so "Priya Shah" goes before "Shah".
  const ordered = [...terms].sort((a, b) => b.value.length - a.value.length);
  for (const term of ordered) {
    if (term.rule === "digits") {
      out = out.replace(/\+?\d[\d\s().\-/]{6,}\d/g, (run) => (run.replace(/\D/g, "").includes(term.value) ? PLACEHOLDER.phone : run));
      continue;
    }
    out = out.replace(pattern(term), (match) => (term.rule === "phrase" || /^\p{Lu}/u.test(match) ? PLACEHOLDER[term.kind] : match));
  }
  return out;
}

const KIND_LABEL: Record<LeakKind, string> = {
  name: "a name",
  company: "a company",
  email: "an email address",
  phone: "a phone number",
  profile: "a LinkedIn profile",
};

/** "Priya Shah (a name), Zeta Labs (a company)": what the rep is told. Phone numbers show only their last 4 digits. */
export function describeLeaks(matches: readonly LeakMatch[]): string {
  return matches
    .map((match) => `${match.kind === "phone" ? `…${match.value.slice(-4)}` : match.value} (${KIND_LABEL[match.kind]})`)
    .join(", ");
}
