# MCP server: plan

Status: v1 built, 12 Nov 2026 (`docs/mcp.mdx` is the user-facing page). Phase 2 is open.

One change from this plan: the write operations also refuse while
`PAUSE_CAMPAIGN_MUTATIONS` / `PEOPLE_MIGRATION_MODE` is on
(`assertCampaignWritesAllowed`). `proxy.ts` matches that pause by path
(`/api/v1/campaigns`), so without this check MCP calls at `/api/v1/mcp`
would have got around it.

## Goal

Let an AI assistant (Claude Code, Claude Desktop, Cursor, any MCP client) work
with an organization's email campaigns through the Model Context Protocol,
with the same API key and the same rules as the public API (`docs/api.mdx`).

Version 1 matches the REST API exactly. An MCP tool is one more way in to the
same operations, not a second set of rules.

## Shape

- **Endpoint: `/api/v1/mcp`.** It is under the `/api/v1/` prefix that
  `proxy.ts` already makes public. The prefix's rule (every route starts with
  `withApiKey()`) covers it, so `proxy.ts` does not change.
- **Transport: Streamable HTTP, stateless, JSON responses.** Use
  `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`
  (1.32.2, pinned). It takes a Web `Request` and returns a `Response`, which
  is what a Next.js route handler has. The options are
  `sessionIdGenerator: undefined` (no sessions) and `enableJsonResponse: true`
  (no SSE).
  - Stateless means no session state in memory, so it works on more than one
    instance. This matters because the rep relay already depends on a single
    instance; this endpoint should not add to that.
  - Every request builds its own `McpServer` and transport, inside
    `withApiKey`, and they are thrown away afterwards. The tools are cheap to
    register, so this costs nothing that matters.
  - `POST` handles JSON-RPC. `GET` (a server-to-client SSE stream) and
    `DELETE` (ending a session) answer 405, because a stateless server has
    neither.
- **Auth: the existing API key**, `Authorization: Bearer asdr_…`. A missing or
  revoked key gets the same 401 with `WWW-Authenticate: Bearer`. Claude Code
  can connect with:

  ```sh
  claude mcp add --transport http agentsdr https://<host>/api/v1/mcp \
    --header "Authorization: Bearer asdr_..."
  ```

  Clients that can only use OAuth, such as claude.ai custom connectors, are
  left for phase 2 (see below).
- **Organization scope.** `withApiKey` runs the handler in
  `runInOrganization`. With JSON responses, `handleRequest` waits for each
  tool's result before it returns, so the tool callbacks run inside that
  async context and `inOrg()` / `currentOrganizationId()` work in them as
  they do in the REST routes. A test must prove this (below). If it ever
  fails, it fails closed: `currentOrganizationId()` throws outside a scope.

## Tools (v1)

| Tool | Same as | Annotations |
|---|---|---|
| `list_campaigns` | `GET /api/v1/campaigns` | readOnly |
| `add_leads_to_campaign` | `POST /api/v1/campaigns/:id/leads` | idempotent (duplicates are skipped), not destructive |
| `stop_campaign_leads` | `POST /api/v1/campaigns/:id/leads/stop` | idempotent, destructive |

Each tool description tells the model what the REST docs tell a developer:
at most 500 leads or emails per call, extra fields become `{{merge}}`
fields, suppressed and duplicate leads are skipped, and stopping a lead ends
their sequence without suppressing them.

### One implementation, two front doors

The route bodies move into `src/lib/publicApi/operations.ts`:
`listCampaigns()`, `addLeads(campaignId, body)` and
`stopLeads(campaignId, body)`. Each returns the response object or throws
`PublicApiError`. The three REST routes and the three tools both call these
functions, so the routes become one-liners and their responses stay
byte-for-byte the same.

- **Validation stays in `requests.ts`.** The tool's zod `inputSchema`
  describes the shape so the client and the model can see it (fields, types,
  `maxItems: 500`). The input is then still parsed by `parseLeadsRequest` /
  `parseStopRequest`, which remain the authority. If zod and the parser
  disagree, the parser's error is the one returned.
- `campaignIdParam` applies to the tools too: an id that is not a uuid gets
  "Campaign not found".
- **Errors.** A `PublicApiError` becomes a tool result with `isError: true`
  and its message as text, not a JSON-RPC error, so the model reads it and
  can fix its input. Any other error is logged (`[mcp]`) and returned as
  "Something went wrong on the server", as the REST routes do.
- **Results.** Each result is the REST JSON, both as `structuredContent`
  (with an `outputSchema`) and as a text block, for clients that show only
  text.

## Files

- `package.json`: `@modelcontextprotocol/sdk` pinned at `1.32.2`, and `zod`
  (a peer of the SDK; tool schemas use it). Pinned at 4.6.5, the version
  the SDK and Better Auth resolve to: with a different root version the SDK
  installs its own copy and the tool schemas stop typechecking.
- `src/lib/publicApi/operations.ts`: the three operations, moved out of the
  routes.
- `src/lib/publicApi/mcp.ts`: `buildMcpServer()` (registers the tools) and
  `toolResult` / `toolError` (pure: they map operation results and errors to
  tool results).
- `src/app/api/v1/mcp/route.ts`: `POST` is
  `withApiKey(req, () => transport.handleRequest(req))`; `GET` and `DELETE`
  answer 405. `export const dynamic = "force-dynamic"`.
- The three existing `src/app/api/v1/campaigns/**/route.ts` files now call
  `operations.ts`.
- `docs/mcp.mdx` (added to `docs.json` next to `api`): the endpoint, how to
  connect from Claude Code, Claude Desktop and Cursor, and the tools. Add a
  link to it from `docs/api.mdx`.
- Settings → API keys: one line under the key list that shows the MCP URL
  ready to copy (`NEXT_PUBLIC_APP_URL` + `/api/v1/mcp`).
- `CLAUDE.md`, under "The public API": a short paragraph saying MCP lives at
  `/api/v1/mcp`, that tools call `operations.ts`, and that a new REST
  operation should get its tool in the same change.

No new tables, no new env vars, and no change to `proxy.ts` or the tenancy
registry.

## Checks

- `npx tsc --noEmit` and `npm test`.
- **Unit tests** (`src/lib/publicApi/mcp.test.ts`): `toolResult` /
  `toolError` mapping, including that a `PublicApiError` becomes `isError`
  and that the server error hides its details. Use the SDK's in-memory
  client/server pair to check `tools/list` (names, schemas, annotations) and
  to call a tool whose operation is stubbed.
- **Scope test**: run `handleRequest` inside `runInOrganization` with a tool
  that reads `currentOrganizationId()`, and assert it sees the organization.
  This test is what catches it if a future SDK version starts dispatching
  outside the request's async context.
- **Feature smoke test, local only**: `scripts/e2e/mcp-smoke.ts`, which,
  like `tenancy-isolation.ts`, refuses a non-local `DATABASE_URL`. It connects
  with the SDK's `StreamableHTTPClientTransport` and two organizations' keys,
  then: lists tools; adds two leads and stops one in org A's campaign; checks
  that org B's `list_campaigns` does not include it and that org B's
  `add_leads_to_campaign` on A's campaign is "Campaign not found"; checks
  that a revoked key gets 401. This is scoped to the feature. The whole-app
  isolation sweep stays a deploy-time step.
- By hand: `claude mcp add …` against a local server, then ask it to list
  campaigns.

## Behaviour to know

- **Demo mode**: `DEMO_MODE` refuses every POST that is not on its read-only
  list, so MCP does not work on the public demo, not even `list_campaigns`.
  That is acceptable. If we want it there, add `/api/v1/mcp` to the demo
  read-only POSTs and refuse the two write tools inside the handler.
- **Rate limits**: the REST API has none, so MCP has none. A model can loop,
  but the 500-per-call cap and the import's duplicate check bound the damage.
  Revisit if it happens.
- **Body size**: a 500-lead call is well under Next.js's default limit for a
  route handler body. No configuration is needed.

## Phase 2 (not in this change)

- **OAuth**, so claude.ai custom connectors and other OAuth-only clients can
  connect without pasting a key: `/.well-known/oauth-protected-resource`,
  `resource_metadata` in the 401's `WWW-Authenticate`, and an authorization
  server. Better Auth's MCP / OIDC provider plugin is the first thing to
  evaluate; a token from it would resolve to (user, organization) and then
  to the same `runInOrganization`. Membership checks apply, because a token
  acts as a person, not an organization key.
- **More tools, read-only first**: a campaign's stats, one lead's status in a
  campaign, and CRM Action required. Each one gets its REST endpoint first,
  so the two front doors stay level.
- **Key scopes** (read-only vs. write), useful once an assistant holds a key.
