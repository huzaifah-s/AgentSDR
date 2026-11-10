import "server-only";

import { PermanentRunError } from "@/lib/grid/runners/types";
import type { CellResult } from "@/lib/grid/types";
import { asRecord, mapConfiguredOutputs, truncate } from "../server/helpers";
import type { IntegrationActionContext, IntegrationActionHandlers } from "../server/types";
import { buildSearchBody, companyDomain } from "./filters";
import { requestCompanyEnrich, type CompanyEnrichPath } from "./transport";

async function execute(context: IntegrationActionContext): Promise<CellResult> {
  const { action, config, inputs, credentials, timeoutMs, signal } = context;
  const isCompany = action.handlerKey === "companyenrich.enrichCompany";
  const isPeople = action.handlerKey === "companyenrich.searchPeople";
  const path: CompanyEnrichPath = isCompany ? "/companies/enrich" : isPeople ? "/people/search" : "/companies/search";
  const query = isCompany ? new URLSearchParams({ domain: companyDomain(inputs.domain), waitForEnrichment: "false" }) : undefined;
  const body = isCompany ? undefined : buildSearchBody(isPeople, inputs);
  const response = await requestCompanyEnrich(path, credentials.apiKey, { query, body, timeoutMs, signal });
  const root = asRecord(response.body);
  if (response.status !== 404 && (isCompany ? typeof root.id !== "string" || !root.id : !Array.isArray(root.items))) {
    throw new PermanentRunError("CompanyEnrich returned an unexpected response. No automatic retry was made; check account usage before retrying.");
  }
  const items = Array.isArray(root.items) ? root.items : [];
  const found = isCompany ? response.status !== 404 : items.length > 0;
  const logicalOutputs = isCompany ? {
    companyId: root.id, companyName: root.name, domain: root.domain, website: root.website,
    industry: root.industry, employeeRange: root.employees, description: root.description,
    linkedinUrl: asRecord(root.socials).linkedin_url,
  } : {
    [isPeople ? "people" : "companies"]: items, resultCount: items.length,
    page: root.page, totalItems: root.totalItems, totalPages: root.totalPages,
  };
  return {
    value: found ? "Found" : "Not found",
    outputs: mapConfiguredOutputs(config, { ...logicalOutputs, data: response.body, creditsConsumed: response.credits }, response.body),
    provider: "companyenrich", outcome: found ? "hit" : "miss", costCents: 0,
    latencyMs: response.latencyMs,
    request: { method: isCompany ? "GET" : "POST", endpoint: path, inputKeys: Object.keys(inputs) },
    response: truncate(response.body),
  };
}

export const COMPANYENRICH_HANDLERS: IntegrationActionHandlers = {
  "companyenrich.enrichCompany": execute,
  "companyenrich.searchCompanies": execute,
  "companyenrich.searchPeople": execute,
};
