import type { ActionInputDefinition, ActionOutputDefinition, IntegrationDefinition } from "../types";

const paginationInputs: ActionInputDefinition[] = [
  { key: "page", name: "Page", description: "One page per execution, starting at 1. Defaults to 1; page × page size cannot exceed 10,000.", valueType: "number", acceptedColumnTypes: ["number"], required: false, group: "advanced" },
  { key: "pageSize", name: "Page size", description: "Results per request, from 1 to 100. Defaults to 10. More results consume more credits.", valueType: "number", acceptedColumnTypes: ["number"], required: false, group: "advanced" },
];

const responseOutputs: ActionOutputDefinition[] = [
  { key: "creditsConsumed", name: "Credits consumed", description: "Reported CompanyEnrich credits, including zero. Empty when the API does not report usage; not a currency amount.", columnType: "number" },
  { key: "data", name: "Full response", description: "Complete provider response. Integers outside JavaScript's safe range are kept as exact decimal strings.", columnType: "json" },
];

const pageOutputs: ActionOutputDefinition[] = [
  { key: "resultCount", name: "Results returned", columnType: "number" },
  { key: "page", name: "Page", columnType: "number" },
  { key: "totalItems", name: "Total matching results", columnType: "number" },
  { key: "totalPages", name: "Total pages", columnType: "number" },
  ...responseOutputs,
];

export const COMPANYENRICH: IntegrationDefinition = {
  key: "companyenrich",
  name: "CompanyEnrich",
  description: "Research companies and professional profiles using your CompanyEnrich account. People search does not find email addresses.",
  websiteUrl: "https://companyenrich.com",
  iconText: "CE",
  iconBackground: "#111827",
  auth: {
    type: "api_key",
    fields: [{ key: "apiKey", label: "API key", placeholder: "CompanyEnrich API key, without Bearer", inputType: "password", required: true }],
    helpUrl: "https://docs.companyenrich.com/reference/get_me",
  },
  actions: [
    {
      key: "enrich-company",
      name: "Enrich company by domain",
      description: "Retrieve a company profile for 1 credit. Uses stored data immediately; a company not yet stored is scheduled by CompanyEnrich and returns a free miss. Run again manually later if needed.",
      docsUrl: "https://docs.companyenrich.com/reference/get_companies-enrich",
      category: "enrich-company-info", type: "enrichment", tags: ["company", "domain", "firmographics"],
      inputs: [{ key: "domain", name: "Company domain", description: "Company website or domain, such as example.com.", valueType: "domain", acceptedColumnTypes: ["text", "url"], required: true, example: "example.com" }],
      outputs: [
        { key: "companyId", name: "Company ID", columnType: "text" },
        { key: "companyName", name: "Company name", columnType: "text" },
        { key: "domain", name: "Domain", columnType: "text" },
        { key: "website", name: "Website", columnType: "url" },
        { key: "industry", name: "Industry", columnType: "text" },
        { key: "employeeRange", name: "Employee range", columnType: "text" },
        { key: "description", name: "Description", columnType: "text" },
        { key: "linkedinUrl", name: "Company LinkedIn URL", columnType: "url" },
        ...responseOutputs,
      ],
      handlerKey: "companyenrich.enrichCompany", implemented: true, creditsPerRun: 1,
    },
    {
      key: "search-companies", name: "Search companies",
      description: "Find companies using names, semantic descriptions and firmographic filters. One bounded page: 1 credit per result, with a 1-credit minimum even when no results match.",
      docsUrl: "https://docs.companyenrich.com/reference/post_companies-search",
      category: "enrich-company-info", type: "enrichment", tags: ["company search", "prospecting", "firmographics"],
      filterBuilder: { minFilters: 1 },
      inputs: [
        { key: "query", name: "Name or domain query", description: "Text to match against company name or domain (up to 250 characters).", valueType: "text", acceptedColumnTypes: ["text"], required: false, group: "filter" },
        { key: "semanticQuery", name: "Semantic query", description: "Describe the companies to find in natural language (up to 500 characters).", valueType: "text", acceptedColumnTypes: ["text"], required: false, group: "filter" },
        { key: "filters", name: "Advanced filters (JSON)", description: "CompanyEnrich search fields, including countries, employees, technologies, categories, funding, exclusions and workforce filters. See the action documentation for exact keys and values. Named inputs override matching JSON fields.", valueType: "json", acceptedColumnTypes: ["json", "text"], required: false, group: "filter", example: '{"countries":["US"],"employees":["11-50"],"category":["b2b"]}' },
        ...paginationInputs,
      ],
      outputs: [{ key: "companies", name: "Companies", columnType: "json" }, ...pageOutputs],
      handlerKey: "companyenrich.searchCompanies", implemented: true,
    },
    {
      key: "search-people", name: "Search professional profiles",
      description: "Find people by employer, position and professional filters. Returns profiles, not email addresses. One bounded page: 2 credits per result, with a 2-credit minimum even when no results match.",
      docsUrl: "https://docs.companyenrich.com/reference/post_people-search",
      category: "enrich-person-info", type: "enrichment", tags: ["people search", "professional profiles", "prospecting"],
      filterBuilder: { minFilters: 1 },
      inputs: [
        { key: "domains", name: "Company domains", description: "Up to 2,500 employer domains. Accepts an array, JSON array, or comma/newline-separated text.", valueType: "text", acceptedColumnTypes: ["text", "json", "multiselect"], multiple: true, required: false, group: "filter", example: "example.com" },
        { key: "positionQuery", name: "Job titles", description: "Current job titles. Accepts an array, JSON array, or comma/newline-separated text.", valueType: "text", acceptedColumnTypes: ["text", "json", "multiselect"], multiple: true, required: false, group: "filter", example: "VP Sales" },
        { key: "filters", name: "Advanced filters (JSON)", description: "CompanyEnrich people-search fields, including seniority, department, countries, education, dates, exclusions and companyFilter. Named inputs override matching JSON fields.", valueType: "json", acceptedColumnTypes: ["json", "text"], required: false, group: "filter", example: '{"countries":["US"],"seniority":["vp"]}' },
        ...paginationInputs,
      ],
      outputs: [{ key: "people", name: "People profiles", description: "Professional profiles, with exact large IDs as text. Does not provide email addresses.", columnType: "json" }, ...pageOutputs],
      handlerKey: "companyenrich.searchPeople", implemented: true,
    },
  ],
};
