"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { ac, roles } from "./permissions";

/**
 * The browser side of Better Auth: sign-in/up/out, the active organization,
 * invitations and teams. Same origin as the app, so no baseURL is needed.
 *
 * oauthProviderClient carries an OAuth authorization through sign-in and the
 * /oauth pages: on a page whose URL holds the plugin's signed query (`sig`),
 * it adds that query to each POST. Without `sig` it adds nothing.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient({ ac, roles, teams: { enabled: true } }), oauthProviderClient()],
});

export const { signIn, signUp, signOut, useSession, useActiveOrganization, useListOrganizations, organization } =
  authClient;
