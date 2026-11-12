import { ConnectedAppsSettings } from "@/components/settings/ConnectedAppsSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import { listConnectedApps } from "@/lib/auth/connectedApps";

export const metadata = { title: "Connected apps" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const ctx = await requirePageOrgContext();
  const apps = await listConnectedApps(ctx.userId);
  return (
    <SettingsPage
      title="Connected apps"
      description="Apps you allowed to use BraintreeSDR as you, such as AI assistants connected through MCP."
      width="narrow"
    >
      <ConnectedAppsSettings initialApps={apps} />
    </SettingsPage>
  );
}
