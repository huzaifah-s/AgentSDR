import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { getIntegrationAction } from "../catalog";
import { getIntegrationActionHandler } from "../server/registry";
import type { IntegrationActionContext } from "../server/types";
import { verifyIntegrationCredentials } from "../verification";
import { PermanentRunError } from "@/lib/grid/runners/types";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

function fetchResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  const spy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(body, { status, headers: { "content-type": "application/json", ...headers } }));
  spies.push(spy);
  return spy;
}

function context(actionKey: string, inputs: Record<string, unknown>): IntegrationActionContext {
  const action = getIntegrationAction("companyenrich", actionKey);
  if (!action) throw new Error(`Action not registered: ${actionKey}`);
  return {
    action, inputs, credentials: { apiKey: "fictional-key" }, connectionId: "fictional-org-connection", timeoutMs: 5000,
    config: {
      integrationKey: "companyenrich", actionKey, handlerKey: action.handlerKey, inputs: {},
      outputs: Object.fromEntries(action.outputs.map((output) => [output.key, `mapped_${output.key}`])),
      connectionId: "fictional-org-connection",
    },
  };
}

async function run(actionKey: string, inputs: Record<string, unknown>) {
  const ctx = context(actionKey, inputs);
  const handler = getIntegrationActionHandler(ctx.action.handlerKey);
  if (!handler) throw new Error("Handler not registered");
  const result = await handler(ctx);
  if ("pending" in result) throw new Error("CompanyEnrich must not poll automatically");
  return result;
}

describe("CompanyEnrich table actions", () => {
  test("enriches the normalized domain once and maps the profile, credits and complete response", async () => {
    const profile = { id: "87ec4df0-6edc-4e6d-931e-9f60e2dbd7cd", name: "Fictional Company", domain: "example.com", employees: "11-50", socials: { linkedin_url: "https://linkedin.com/company/fictional-example" }, futureField: { value: null } };
    const fetch = fetchResponse(JSON.stringify(profile), 200, { "x-credit-cost": "1" });
    const result = await run("enrich-company", { domain: "https://www.example.com/about" });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.companyenrich.com/companies/enrich?domain=example.com&waitForEnrichment=false");
    expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", headers: { Authorization: "Bearer fictional-key" } });
    expect(result.outputs).toMatchObject({ mapped_companyId: profile.id, mapped_companyName: profile.name, mapped_employeeRange: "11-50", mapped_creditsConsumed: 1, mapped_data: profile });
    expect(result.costCents).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.request)).not.toContain("fictional-key");
  });

  test("returns a free cached miss without retaining an upstream error payload", async () => {
    fetchResponse('{"apiKey":"do-not-store","detail":"internal error"}', 404);
    const result = await run("enrich-company", { domain: "missing.example.com" });
    expect(result.outcome).toBe("miss");
    expect(result.outputs).toMatchObject({ mapped_data: null, mapped_creditsConsumed: 0 });
    expect(JSON.stringify(result)).not.toContain("do-not-store");
  });

  test("searches one bounded company page with advanced nested filters", async () => {
    const body = { items: [{ id: "87ec4df0-6edc-4e6d-931e-9f60e2dbd7cd", name: null }], page: 2, totalItems: 42, totalPages: 5, extra: true };
    const fetch = fetchResponse(JSON.stringify(body), 200, { "x-credit-cost": "1" });
    const result = await run("search-companies", { semanticQuery: "supply chain software", page: 2, pageSize: 10, filters: { category: ["b2b"], foundedYear: { min: 2015, max: 2020 }, exclude: { domains: ["example.org"] }, workforceSize: [{ department: "engineering_technical", min: 5 }] } });
    expect(String(fetch.mock.calls[0][0])).toBe("https://api.companyenrich.com/companies/search");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ category: ["b2b"], foundedYear: { min: 2015, max: 2020 }, exclude: { domains: ["example.org"] }, workforceSize: [{ department: "engineering_technical", min: 5 }], semanticQuery: "supply chain software", page: 2, pageSize: 10 });
    expect(result.outputs).toMatchObject({ mapped_companies: body.items, mapped_resultCount: 1, mapped_totalItems: 42, mapped_page: 2, mapped_data: body });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("keeps 64-bit person IDs exact and uses domains, position and education filters", async () => {
    const fetch = fetchResponse('{"items":[{"id":9223372036854775807,"name":"Fictional Person","position":"VP Sales","future":"digits 9223372036854775807"}],"page":1,"totalItems":1,"creditsConsumed":0}', 200, { "x-credit-cost": "2" });
    const result = await run("search-people", { domains: "example.com,example.org", positionQuery: '["VP Sales","Revenue"]', filters: { education: { institutionNameQuery: ["Fictional University"] }, seniority: ["vp"] } });
    expect(String(fetch.mock.calls[0][0])).toBe("https://api.companyenrich.com/people/search");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ education: { institutionNameQuery: ["Fictional University"] }, seniority: ["vp"], domains: ["example.com", "example.org"], positionQuery: ["VP Sales", "Revenue"], page: 1, pageSize: 10 });
    expect(result.outputs?.mapped_people).toEqual([{ id: "9223372036854775807", name: "Fictional Person", position: "VP Sales", future: "digits 9223372036854775807" }]);
    expect(result.outputs?.mapped_creditsConsumed).toBe(0);
    expect(JSON.stringify(result)).not.toContain('"email"');
  });

  test("maps configured JSON pointers from the complete response", async () => {
    fetchResponse('{"items":[{"id":9223372036854775807,"name":"Fictional Person"}]}');
    const ctx = context("search-people", { domains: ["example.com"] });
    ctx.config.outputs = { "response:/items/0/id": "person_id" };
    const handler = getIntegrationActionHandler(ctx.action.handlerKey)!;
    const result = await handler(ctx);
    if ("pending" in result) throw new Error("Unexpected async response");
    expect(result.outputs?.person_id).toBe("9223372036854775807");
  });

  test("retains a billable empty page and unknown credits without inventing zero", async () => {
    fetchResponse('{"items":[],"page":1,"totalItems":0,"totalPages":0}');
    const result = await run("search-companies", { query: "fictional" });
    expect(result.outcome).toBe("miss");
    expect(result.outputs?.mapped_creditsConsumed).toBeNull();
    expect(result.outputs?.mapped_resultCount).toBe(0);
  });

  test("supports nested people company filters including similar-company workforce bounds", async () => {
    const fetch = fetchResponse('{"items":[],"page":1}');
    const filters = { companyFilter: { similar: { domains: ["example.com"], workforceSize: [{ department: "sales", min: 5, max: 20 }] } }, atCurrentCompanyAfter: "2024-02-29T00:00:00Z" };
    await run("search-people", { filters: JSON.stringify(filters) });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ ...filters, page: 1, pageSize: 10 });
  });

  test.each([
    ["search-companies", { query: "test", pageSize: 101 }],
    ["search-companies", { query: "test", page: 0 }],
    ["search-companies", { query: "test", page: 101, pageSize: 100 }],
    ["search-companies", { query: "test", page: 1.5 }],
    ["search-companies", { filters: {} }],
    ["search-companies", { filters: { industry: ["invented filter"] } }],
    ["search-companies", { filters: { semanticWeight: 2, query: "test" } }],
    ["search-companies", { filters: { employees: ["invented range"] } }],
    ["search-companies", { filters: { foundedYear: { min: 2020, max: 2010 } } }],
    ["search-companies", { filters: { lists: ["not-a-uuid"] } }],
    ["search-people", { filters: { atCurrentPositionAfter: "not-a-date" } }],
    ["search-people", { filters: { atCurrentPositionAfter: "2025-02-30T12:00:00Z" } }],
    ["search-people", { filters: { atCurrentCompanyAfter: "2025-02-02T00:00:00Z", atCurrentCompanyBefore: "2025-01-01T00:00:00Z" } }],
    ["search-people", { filters: { companyFilter: { similar: { domains: ["example.com"], workforceSize: [{ min: 20, max: 5 }] } } } }],
    ["search-people", { filters: { companyDomain: "example.com" } }],
    ["search-people", { positionQuery: ["😀".repeat(20_000)] }],
    ["search-people", { domains: Array.from({ length: 2501 }, () => "example.com") }],
    ["search-people", { filters: "[]" }],
    ["enrich-company", { domain: "https://user:password@example.com" }],
    ["enrich-company", { domain: "ftp://example.com" }],
  ] as const)("rejects invalid %s input before spending", async (action, inputs) => {
    const fetch = fetchResponse("{}");
    await expect(run(action, inputs)).rejects.toBeInstanceOf(PermanentRunError);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([401, 402, 403, 429, 500, 302])("does not retry or expose upstream secrets for HTTP %i", async (status) => {
    const fetch = fetchResponse('{"message":"secret key and private account details"}', status);
    try { await run("search-companies", { query: "test" }); throw new Error("Expected a failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(PermanentRunError);
      expect(String(error)).not.toContain("secret key");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("turns ambiguous network failures into permanent errors so the queue cannot replay a paid call", async () => {
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("sensitive transport details"));
    spies.push(fetch);
    await expect(run("search-people", { domains: ["example.com"] })).rejects.toBeInstanceOf(PermanentRunError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("does not spend if the caller has already cancelled the job", async () => {
    const fetch = fetchResponse('{"items":[]}');
    const ctx = context("search-people", { domains: ["example.com"] });
    ctx.signal = AbortSignal.abort();
    await expect(getIntegrationActionHandler(ctx.action.handlerKey)!(ctx)).rejects.toBeInstanceOf(PermanentRunError);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([true, false])("bounds response bytes, with content-length=%s", async (withHeader) => {
    const fetch = fetchResponse(JSON.stringify({ items: [], text: "x".repeat(2 * 1024 * 1024) }), 200, withHeader ? { "content-length": "2097180" } : {});
    await expect(run("search-companies", { query: "test" })).rejects.toBeInstanceOf(PermanentRunError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("uses the prepared connection credentials on each call without caching another organization's key", async () => {
    const fetch = fetchResponse('{"items":[]}');
    const first = context("search-companies", { query: "test" });
    first.credentials = { apiKey: "fictional-org-a" };
    await getIntegrationActionHandler(first.action.handlerKey)!(first);
    fetch.mockResolvedValueOnce(new Response('{"items":[]}'));
    const second = context("search-companies", { query: "test" });
    second.credentials = { apiKey: "fictional-org-b" };
    await getIntegrationActionHandler(second.action.handlerKey)!(second);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual(["Bearer fictional-org-a", "Bearer fictional-org-b"]);
  });

  test.each(["", "Bearer fictional-key", "fictional\r\nheader"]) ("rejects an invalid credential format before making a request", async (key) => {
    const fetch = fetchResponse("{}");
    await expect(verifyIntegrationCredentials("companyenrich", { apiKey: key })).rejects.toBeInstanceOf(PermanentRunError);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(["not JSON", "null", '{"unexpected":true}'])("rejects malformed successful responses: %s", async (body) => {
    fetchResponse(body);
    await expect(run("search-companies", { query: "test" })).rejects.toBeInstanceOf(PermanentRunError);
  });

  test("verifies credentials only through free /me and discards account data", async () => {
    const fetch = fetchResponse('{"apiKey":"never-return-this","credits":100}');
    expect(await verifyIntegrationCredentials("companyenrich", { apiKey: "fictional-key" })).toBeUndefined();
    expect(String(fetch.mock.calls[0][0])).toBe("https://api.companyenrich.com/me");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
