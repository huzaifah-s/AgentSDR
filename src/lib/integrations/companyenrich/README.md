# CompanyEnrich

[CompanyEnrich](https://companyenrich.com) provides company and professional-profile data for prospect research. This provider adds the three actions agreed in [#4](https://github.com/Kandid-ai/AgentSDR/issues/4): company enrichment by domain, company search, and people search. People search returns professional profiles; it does not find email addresses.

## Connect and run

1. Open a table's enrichment dialog, select **CompanyEnrich**, and choose one of its actions. Under **Account**, choose **Add account**, enter an API key without the `Bearer` prefix, and select **Verify & connect**. AgentSDR stores it through the existing organization-scoped encrypted connection system. Verification uses the free [`GET /me`](https://docs.companyenrich.com/reference/get_me) operation and discards its response, which may contain the key.
2. Select the verified connection, bind the input columns, and map the outputs to table columns. Search actions require at least one filter.
3. Run an explicit row or selection. Every execution makes at most one provider request. Check the account's credit allowance before running large selections.

| Action | Inputs | Results and credit behavior |
| --- | --- | --- |
| [Enrich company by domain](https://docs.companyenrich.com/reference/get_companies-enrich) | Company domain or HTTP(S) website | Stored company profile for 1 credit. Uses `waitForEnrichment=false`; an uncached company returns a free miss and CompanyEnrich may schedule enrichment. Run again manually later if desired. |
| [Search companies](https://docs.companyenrich.com/reference/post_companies-search) | Name/domain query, semantic query, or advanced filters | One page of companies. 1 credit per result, with a 1-credit minimum even for an empty page. |
| [Search professional profiles](https://docs.companyenrich.com/reference/post_people-search) | Employer domains, job titles, or advanced filters | One page of professional profiles. 2 credits per result, with a 2-credit minimum even for an empty page. |

Search defaults are page 1 and page size 10. A page size of 1–100 is allowed, within the first 10,000 results. The provider handler does not automatically paginate, poll, or retry. Its transient failures are marked permanent for AgentSDR's queue because a failed or timed-out paid request may already have consumed credits. AgentSDR's existing worker recovery can still replay an abandoned job after a process crash or a result-persistence failure; this integration does not guarantee exactly-once billing. Check account usage before manually retrying.

`Credits consumed` preserves the API's reported `creditsConsumed` field, or `x-credit-cost` header if absent. An explicit zero stays zero; missing usage stays empty, except the documented free enrichment miss. Provider credits are not currency, so AgentSDR's monetary cost remains zero. `Full response` retains the provider response, including fields without dedicated outputs and future fields. JSON-pointer output mappings also work. Integers outside JavaScript's safe range, including large person IDs, are retained as exact decimal strings. Responses are bounded to 2 MiB; the existing audit-log helper may truncate its separate response copy.

## Advanced search filters

Bind a JSON object or JSON text column to **Advanced filters (JSON)**. Named input columns override matching JSON fields. Employer domains and job titles also accept arrays or comma/newline-separated text. Use the exact names and enums in the linked operation reference; unknown fields, unsupported enum values, invalid bounds, and malformed values are rejected before spending credits.

Company example:

```json
{
  "countries": ["US"],
  "category": ["b2b"],
  "employees": ["11-50", "51-200"],
  "foundedYear": { "min": 2015, "max": 2024 },
  "workforceSize": [{ "department": "engineering_technical", "min": 5 }],
  "exclude": { "domains": ["example.org"] }
}
```

People example:

```json
{
  "domains": ["example.com"],
  "positionQuery": ["VP Sales", "Revenue"],
  "seniority": ["vp", "head"],
  "countries": ["US"],
  "atCurrentCompanyAfter": "2024-01-01T00:00:00Z"
}
```

The full request filter shapes include funding, categories, workforce, exclusions, education, and nested people `companyFilter.search` / `companyFilter.similar`. `schemas.ts` retains the relevant request schemas and enums from the public [OpenAPI contract](https://api.companyenrich.com/openapi/v1.json), retrieved November 3, 2026. The public similar-company schema leaves `workforceSize.items` untyped; validation deliberately uses the corresponding company-search workforce shape. Requests are bounded to 64 KiB. There are no additional company/people lookup, email, export, bulk, or scroll actions in this initial scope.

## Validation

The TypeScript fixtures call the actual registered handlers and verifier with mocked HTTP responses. They cover input validation before paid calls, nested filters, pagination, response mapping, exact IDs, reported credits, free credential verification, connection-local keys, cancelled calls, response-size limits, and permanent errors without automatic retries. They do not use real credentials or spend credits.

```sh
bun test --conditions=react-server src/lib/integrations/companyenrich/actions.test.ts
npx tsc --noEmit
npm test
bun run lint
bun run build
```

Maintainer live verification still requires a privately arranged dedicated test key/trial credits, as requested in #4. Do not paste a key into an issue or pull request. Suggested manual checks with that account: connect through the enrichment dialog; run one company enrichment; run each search with page size 1; inspect full-response and ID/credit mappings; confirm the account records the expected usage. No live verification is claimed by the fixture suite.
