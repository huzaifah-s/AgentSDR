import { ApiKeysSettings } from "@/components/settings/ApiKeysSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { Callout } from "@/components/settings/SettingsKit";
import { can, requirePageOrgContext } from "@/lib/auth/context";
import { listApiKeys } from "@/lib/publicApi/keys";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const ctx = await requirePageOrgContext();
  const canManage = can(ctx, { integrations: ["manage"] });
  const keys = canManage ? await runInOrganization(ctx.organizationId, listApiKeys) : [];
  return (
    <SettingsPage
      title="API keys"
      description="Let another application add leads to your email campaigns and stop their sequences."
      width="narrow"
    >
      {canManage ? (
        <ApiKeysSettings initialKeys={keys} />
      ) : (
        <Callout tone="info">Only owners and admins can manage API keys.</Callout>
      )}
    </SettingsPage>
  );
}
