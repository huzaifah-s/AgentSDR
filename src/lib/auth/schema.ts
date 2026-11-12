import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Better Auth's tables: identity (users, sessions, accounts, verifications)
 * and the organization plugin with teams (organizations, members,
 * invitations, teams, team_members).
 *
 * Written by hand from the generator's output for better-auth 1.7.7
 * (`generateId: "uuid"`, `usePlural: true`, organization({ teams })) — the
 * generated file imports drizzle v1's `defineRelationsPart`, which our
 * drizzle-orm 0.45 does not have. The JS property names are Better Auth's
 * field names and must not change; the column names are ours (snake_case).
 * Plural table names match this app's convention and keep clear of the
 * singular `user`/`organization` tables an older app on the same database
 * server once used.
 *
 * The matching DDL is scripts/create-auth-tables.ts; keep the two in sync.
 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Better Auth writes these as strings; they hold organization/team uuids. */
    activeOrganizationId: text("active_organization_id"),
    activeTeamId: text("active_team_id"),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The provider's id for the user; for email + password it is the user id. */
    accountId: text("account_id").notNull(),
    /** "credential" for email + password, "google" for Google. */
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    /** scrypt hash, set only on the "credential" account. */
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: createdAt(),
  metadata: text("metadata"),
});

export const members = pgTable(
  "members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** owner | admin | member — comma-separated when a member holds several. */
    role: text("role").default("member").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("members_organization_id_idx").on(t.organizationId), index("members_user_id_idx").on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    teamId: text("team_id"),
    /** pending | accepted | rejected | canceled */
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("invitations_organization_id_idx").on(t.organizationId), index("invitations_email_idx").on(t.email)],
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    memberCount: integer("member_count").default(0).notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).$onUpdate(() => new Date()),
  },
  (t) => [index("teams_organization_id_idx").on(t.organizationId)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    membershipKey: text("membership_key").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("team_members_team_id_idx").on(t.teamId), index("team_members_user_id_idx").on(t.userId)],
);

/** Exactly the keys the Drizzle adapter looks up with `usePlural: true`. */
// ---------------------------------------------------------------- OAuth provider

/*
 * @better-auth/oauth-provider 1.7.7's tables (src/lib/auth/server.ts), so MCP
 * clients that connect only through OAuth (claude.ai connectors) can act as a
 * signed-in person inside one organization (docs/mcp/plan.md, phase 2).
 *
 * Field names are the plugin's and must not change. "string[]" fields are
 * text[] (the Drizzle adapter passes arrays through on Postgres), "json" is
 * jsonb. Tokens, codes and client secrets are stored as SHA-256 hashes by the
 * plugin. A token's `referenceId` is the organization the person chose at
 * consent; every MCP request re-checks their membership in it
 * (src/lib/publicApi/oauth.ts). DDL: scripts/create-oauth-provider-tables.ts.
 */

const at = (name: string) => timestamp(name, { withTimezone: true });

export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("client_credentials_scopes").array().default([]),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: at("created_at").defaultNow(),
    updatedAt: at("updated_at").defaultNow(),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauth_clients_user_id_idx").on(t.userId)],
);

export const oauthResources = pgTable("oauth_resources", {
  id: uuid("id").defaultRandom().primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
  disabled: boolean("disabled").default(false),
  createdAt: at("created_at").defaultNow(),
  updatedAt: at("updated_at").defaultNow(),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResources = pgTable(
  "oauth_client_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: at("created_at").defaultNow(),
  },
  (t) => [
    uniqueIndex("oauth_client_resources_client_resource_uq").on(t.clientId, t.resourceId),
    index("oauth_client_resources_resource_id_idx").on(t.resourceId),
  ],
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: at("expires_at"),
    createdAt: at("created_at").defaultNow(),
    revoked: at("revoked"),
    rotatedAt: at("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: at("rotation_replay_expires_at"),
    authTime: at("auth_time"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_refresh_tokens_client_id_idx").on(t.clientId),
    index("oauth_refresh_tokens_session_id_idx").on(t.sessionId),
    index("oauth_refresh_tokens_user_id_idx").on(t.userId),
    index("oauth_refresh_tokens_authorization_code_id_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: uuid("refresh_id").references(() => oauthRefreshTokens.id, { onDelete: "cascade" }),
    expiresAt: at("expires_at"),
    createdAt: at("created_at").defaultNow(),
    revoked: at("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_access_tokens_client_id_idx").on(t.clientId),
    index("oauth_access_tokens_session_id_idx").on(t.sessionId),
    index("oauth_access_tokens_user_id_idx").on(t.userId),
    index("oauth_access_tokens_authorization_code_id_idx").on(t.authorizationCodeId),
    index("oauth_access_tokens_refresh_id_idx").on(t.refreshId),
  ],
);

export const oauthConsents = pgTable(
  "oauth_consents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: at("created_at").defaultNow(),
    updatedAt: at("updated_at").defaultNow(),
  },
  (t) => [index("oauth_consents_client_id_idx").on(t.clientId), index("oauth_consents_user_id_idx").on(t.userId)],
);

/** Used client-assertion ids (replay protection). The id is the plugin's own digest of the assertion's jti, not a uuid. */
export const oauthClientAssertions = pgTable("oauth_client_assertions", {
  id: text("id").primaryKey(),
  expiresAt: at("expires_at").notNull(),
});

export const authSchema = {
  users,
  sessions,
  accounts,
  verifications,
  organizations,
  members,
  invitations,
  teams,
  teamMembers,
  oauthClients,
  oauthResources,
  oauthClientResources,
  oauthRefreshTokens,
  oauthAccessTokens,
  oauthConsents,
  oauthClientAssertions,
};

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Member = typeof members.$inferSelect;
