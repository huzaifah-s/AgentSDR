import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/AuthShell";
import { organizationChoices, oauthSession } from "@/lib/auth/oauthPages.server";
import { OrganizationChoice } from "./OrganizationChoice";

export const dynamic = "force-dynamic";

// Step two of an OAuth authorization for a member of several organizations:
// the token will act inside the one chosen here (src/lib/auth/oauthProvider.ts).
// The plugin sends people here with its signed query, which the choice posts
// back to /api/auth/oauth2/continue.
export default async function OAuthOrganizationPage() {
  const session = await oauthSession();
  if (!session) redirect("/sign-in");
  const choices = await organizationChoices(session.user.id);
  return (
    <AuthShell title="Choose an organization" subtitle="The app you are connecting will work inside the organization you choose.">
      <OrganizationChoice choices={choices} activeOrganizationId={session.session.activeOrganizationId ?? null} />
    </AuthShell>
  );
}
