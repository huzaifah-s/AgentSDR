import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/AuthShell";
import { ErrorCallout } from "@/components/auth/fields";
import { clientSummary, consentOrganizationFor, organizationChoices, oauthSession } from "@/lib/auth/oauthPages.server";
import { API_SCOPES, type ApiScope } from "@/lib/publicApi/access";
import { ConsentForm } from "./ConsentForm";

export const dynamic = "force-dynamic";

// The last step of an OAuth authorization: a person allows (or refuses) an
// app, usually an MCP client such as a claude.ai connector, to act as them
// inside one organization. The plugin sends people here with its signed
// query; ConsentForm posts the answer to /api/auth/oauth2/consent.
export default async function OAuthConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await oauthSession();
  if (!session) redirect("/sign-in");
  const query = await searchParams;
  const clientId = typeof query.client_id === "string" ? query.client_id : "";
  const requested = (typeof query.scope === "string" ? query.scope : "").split(" ").filter(Boolean);

  const [client, choices] = await Promise.all([clientId ? clientSummary(clientId) : null, organizationChoices(session.user.id)]);
  const organization = consentOrganizationFor(choices, session.session.activeOrganizationId);
  const scopes = API_SCOPES.filter((scope): scope is ApiScope => requested.includes(scope));

  if (!client || !organization || scopes.length === 0) {
    return (
      <AuthShell title="This link cannot be used">
        <ErrorCallout>
          {!client
            ? "The app asking for access is not registered here."
            : !organization
              ? "You are not a member of an organization this app could use."
              : "The app did not ask for anything BraintreeSDR can grant."}{" "}
          Start connecting again from the app.
        </ErrorCallout>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={`Allow ${client.name} to use BraintreeSDR?`} subtitle={`It will act as you (${session.user.email}) in ${organization.name}.`}>
      <ConsentForm scopes={scopes} offlineAccess={requested.includes("offline_access")} clientName={client.name} clientUri={client.uri} />
    </AuthShell>
  );
}
