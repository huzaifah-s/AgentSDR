import AddMailboxButton from "@/components/outreach/AddMailboxButton";
import MailboxesPageClient from "@/components/outreach/MailboxesPageClient";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";
import { listMailboxes } from "@/lib/outreach/mailboxes";
import { listImapSmtpSettings } from "@/lib/outreach/imapSmtp";
import { isPlatformConnected } from "@/lib/platform/credentials";

export const dynamic = "force-dynamic";

export const metadata = { title: "Email accounts" };

/**
 * Not behind Google Workspace: an SMTP + IMAP mailbox needs no integration,
 * so the page always lists mailboxes and offers Add; Google is only one of
 * the two ways in.
 */
async function loadPage() {
  const ctx = await requirePageOrgContext();
  return runInOrganization(ctx.organizationId, async () => {
    const [mailboxes, googleConnected] = await Promise.all([listMailboxes(), isPlatformConnected("google")]);
    const imap = await listImapSmtpSettings(mailboxes.filter((m) => m.provider === "imap").map((m) => m.id));
    return { mailboxes, googleConnected, imapSettings: Object.fromEntries(imap) };
  });
}

export default async function EmailAccountsPage() {
  const { mailboxes, googleConnected, imapSettings } = await loadPage();
  return (
    <SettingsPage
      title="Email accounts"
      description="The mailboxes outreach campaigns send from."
      actions={<AddMailboxButton googleConnected={googleConnected} />}
    >
      <MailboxesPageClient mailboxes={mailboxes} googleConnected={googleConnected} imapSettings={imapSettings} />
    </SettingsPage>
  );
}
