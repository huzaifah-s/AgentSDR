export type Campaign = { id: string; name: string; channel: "email" | "linkedin"; status?: string };

export type PersonRow = {
  person: { id: string; email: string | null; linkedinUrl: string | null; fullName: string | null; firstName?: string | null; lastName?: string | null; title: string | null; profilePictureUrl?: string | null; phone?: string | null; source: string; raw?: Record<string, unknown>; updatedAt: string | Date | null };
  company: { name: string | null; domain: string } | null;
  campaigns: Campaign[];
  crm: { recordId: string; categoryKey: string | null; subcategory: string | null; workflowState: string; activeChannel: string | null; activeSequence: string | null; currentStep: string | null; lastInboundAt: string | Date | null; lastOutboundAt: string | Date | null; lastInteractionAt: string | Date | null; nextActionAt: string | Date | null; unacknowledgedAiChange: boolean } | null;
};

export type CompanyRow = {
  company: { id: string; name: string | null; domain: string; linkedinUrl: string | null; source: string; updatedAt: string | Date };
  peopleCount: number;
  campaigns: Campaign[];
};

export type LeadsTab = "people" | "companies";
export type Direction = "asc" | "desc";

export type PeopleFilters = {
  campaignChannel: string;
  hasEmail: boolean;
  hasLinkedin: boolean;
  crmCategory: string;
  crmSubcategoryId: string;
  crmWorkflowState: string;
  crmAiChange: boolean;
};

export const EMPTY_FILTERS: PeopleFilters = { campaignChannel: "", hasEmail: false, hasLinkedin: false, crmCategory: "", crmSubcategoryId: "", crmWorkflowState: "", crmAiChange: false };

export function activeFilterCount(filters: PeopleFilters): number {
  return [filters.campaignChannel, filters.hasEmail, filters.hasLinkedin, filters.crmCategory, filters.crmSubcategoryId, filters.crmWorkflowState, filters.crmAiChange].filter(Boolean).length;
}

export const PAGE_SIZE = 25;

export const linkedInPersonHref = (value: string) => (value.startsWith("http") ? value : `https://www.linkedin.com/in/${value}`);
export const linkedInCompanyHref = (value: string) => (value.startsWith("http") ? value : `https://www.linkedin.com/company/${value}`);
export const initials = (value: string | null) => (value || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
export const dateLabel = (value: string | Date | null | undefined) => (value
  ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value))
  : "—");

/** "Oct 3" this year, "Oct 3, 2025" otherwise — for dates inside a table cell. */
export const shortDate = (value: string | Date | null | undefined) => {
  if (!value) return "—";
  const date = new Date(value);
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(date);
};

/** Whether a timestamp is still ahead of now. */
export const isFuture = (value: string | Date) => new Date(value).getTime() > Date.now();

/** Sort choices per tab, for the toolbar's sort menu (keys match the API). */
export const SORTS: Record<LeadsTab, Array<{ key: string; label: string }>> = {
  people: [
    { key: "updated", label: "Last updated" },
    { key: "created", label: "Date added" },
    { key: "name", label: "Name" },
    { key: "company", label: "Company" },
    { key: "title", label: "Title" },
    { key: "email", label: "Email" },
  ],
  companies: [
    { key: "updated", label: "Last updated" },
    { key: "name", label: "Name" },
    { key: "domain", label: "Domain" },
    { key: "people", label: "People" },
  ],
};
