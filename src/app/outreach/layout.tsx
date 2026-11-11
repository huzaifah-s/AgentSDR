import Link from "next/link";
import { RiMailLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { DocsLink } from "@/components/page/DocsLink";
import { EmptyState } from "@/components/page/EmptyState";
import { requirePageOrgContext } from "@/lib/auth/context";
import { hasEmailSender } from "@/lib/outreach/mailboxes";
import { PLATFORM_SETTINGS_HREF } from "@/lib/platform/catalog";
import { runInOrganization } from "@/lib/tenancy/scope";

/**
 * The Email section (campaigns, the Master Inbox and its notes and tasks)
 * waits until the organization can send email: Google Workspace is connected,
 * or it has an SMTP + IMAP mailbox (any other provider, no integration
 * needed). Each page supplies its own padding, so only the prompt gets it here.
 */

// Reads the database (can this organization send email?), so the segment renders per request.
export const dynamic = "force-dynamic";

export default async function OutreachLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageOrgContext();
  const ready = await runInOrganization(ctx.organizationId, () => hasEmailSender());
  if (ready) return <>{children}</>;
  return (
    <div className="h-full overflow-auto bg-bg-white-0 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <Frame className="mx-auto max-w-2xl">
        <FramePanel>
          <EmptyState
            icon={RiMailLine}
            title="Connect email to use this"
            description="Add a mailbox from any provider with its SMTP and IMAP login, or connect Google Workspace to send from your Workspace addresses. Campaigns, the inbox and reply sync unlock once either is in place."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button.Root asChild variant="primary" mode="filled" size="small">
                  <Link href="/settings/email-accounts">Add a mailbox</Link>
                </Button.Root>
                <Button.Root asChild variant="neutral" mode="stroke" size="small">
                  <Link href={PLATFORM_SETTINGS_HREF.google}>Connect Google Workspace</Link>
                </Button.Root>
                <DocsLink page="email/connect#add-a-mailbox" />
              </div>
            }
          />
        </FramePanel>
      </Frame>
    </div>
  );
}
