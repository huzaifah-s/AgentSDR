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

## Phase 2: design (12 Nov 2026)

Three pieces, each in its own commit, in this order: the smaller two make
OAuth tokens simpler to describe, because a token's scopes reuse what keys
can do.

### 1. Read-only keys

- `api_keys.access`: `read` or `read_write`, `NOT NULL DEFAULT 'read_write'`
  (`scripts/add-api-key-access.ts`). Every existing key could already write,
  so the default keeps them as they are.
- Settings → API keys: the create form asks "Read and write" (default) or
  "Read only", and the list shows each key's access.
- `withApiKey` hands the handler its caller `{ organizationId, keyId,
  access }`. A REST write route asks for `write` and a read-only key gets
  `403`. The MCP route builds its server with only the tools the caller may
  use, so a read-only key does not see the write tools at all (and the
  server instructions say so) instead of seeing tools that always fail.

### 2. Read-only tools, each with its REST twin

| Tool | REST | Built on |
|---|---|---|
| `get_campaign` | `GET /api/v1/campaigns/:id` | `getCampaign` + `getCampaignStats` (lead counts by status, emails sent/scheduled/failed) |
| `get_campaign_leads` | `GET /api/v1/campaigns/:id/leads?email=…` (up to 100, repeatable) | `outreach_leads` joined to `people`: each address's sequence status, step, next send |
| `list_action_required` | `GET /api/v1/crm/action-required?group=&limit=&offset=` | `listCrmActions` (the CRM's Action required queue), mapped to a compact item: record id, person and company, channel, action, group, due time, category, the latest reply's excerpt, the pending draft's status |

The output is compact on purpose: names, statuses, counts and short
excerpts, not whole threads. A model reads every field of every row.

### 3. OAuth, for connectors that cannot hold a key

`@better-auth/oauth-provider` 1.7.7 (Better Auth's own, matching our
1.7.7), with opaque access tokens (`disableJwtPlugin`, so no signing keys to
manage).

- **Who and which organization.** A token acts as a person, inside one
  organization they pick. The plugin's `postLogin` step sends a person with
  more than one organization to `/oauth/organization`. `consentReferenceId`
  is the organization they picked, after a membership check, so the consent
  and every token carry it as `referenceId`.
- **Scopes:** `campaigns:read`, `campaigns:write`, `crm:read`, plus
  `offline_access` for refresh tokens. A key's `read` is `campaigns:read` +
  `crm:read`; `read_write` adds `campaigns:write`. Tools are filtered by
  scope, the same way they are filtered by a key's access.
- **Per request:** `/api/v1/mcp` accepts either credential. An `asdr_` key
  goes through `organizationForApiKey`; anything else is checked as an access
  token (valid, not expired or revoked, issued for this resource). Then the
  person must **still be a member** of the token's organization, checked on
  every request, so removing someone from an organization cuts off their
  connectors at once.
- **Discovery:** `/.well-known/oauth-protected-resource` (pointing at
  ourselves as the authorization server) and
  `/.well-known/oauth-authorization-server`. Every 401 from `/api/v1/mcp`
  carries `WWW-Authenticate: Bearer resource_metadata="…"`, which is how a
  client finds them.
- **Client registration:** open dynamic registration (RFC 7591), which
  claude.ai and other MCP clients use to register themselves. This is safe
  because a registered client gets nothing on its own: tokens need a signed-in
  person's consent, codes need PKCE, and redirects must match what the client
  registered.
- **Pages:** the plugin sends people to `/sign-in` (which continues the
  OAuth flow after signing in), `/oauth/organization` and `/oauth/consent`.
  Consent names the client, the organization and, in plain words, what each
  scope allows.
- **Settings → Connected apps** lists the apps a person has authorized and
  lets them revoke one.
- **Tables:** the plugin's six (clients, resources, client resources,
  access and refresh tokens, consents), created by
  `scripts/create-oauth-provider-tables.ts` and described in
  `src/lib/auth/schema.ts`. They are classified **global** in the tenancy
  registry, like Better Auth's own tables: a token belongs to a person, and
  its organization is checked against membership on each request, not
  through a column filter.
- **Public in `proxy.ts`:** `/.well-known/oauth-*` and the plugin's endpoints
  under `/api/auth/oauth2/` (Better Auth's handler is already public).

## Later (not planned)

- More write tools (CRM: approve or send a draft, move a stage; LinkedIn;
  calling). Each needs its own decisions about what an assistant may do
  without a person looking, so none is designed yet.
- Rate limits, if a client ever loops.
