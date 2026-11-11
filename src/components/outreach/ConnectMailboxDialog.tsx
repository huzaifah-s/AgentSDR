"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RiCheckLine, RiLoader4Line, RiMailAddLine, RiMailSettingsLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";
import * as Modal from "@/components/alignui/modal";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import * as Select from "@/components/alignui/select";
import * as Textarea from "@/components/alignui/textarea";
import { DocsLink } from "@/components/page/DocsLink";
import { Callout, Field } from "@/components/settings/SettingsKit";
import { IMAP_SMTP_PRESETS, imapSmtpPreset } from "@/lib/outreach/imapSmtpConfig";
import type { ImapSmtpSettings } from "@/lib/outreach/schema";

type Stage = "form" | "testing" | "success" | "failed";
type Provider = "google" | "imap";
type Security = "tls" | "starttls";

const CUSTOM = "custom";

/** An existing SMTP + IMAP mailbox whose servers or password are being changed. */
export type EditImapMailbox = {
  emailAddress: string;
  displayName: string | null;
  settings: ImapSmtpSettings;
};

function TextInput({
  id,
  value,
  onChange,
  type = "text",
  placeholder,
  autoFocus,
  required,
  disabled,
  autoComplete,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: string;
}) {
  return (
    <Input.Root size="medium">
      <Input.Wrapper>
        <Input.Input
          id={id}
          type={type}
          required={required}
          autoFocus={autoFocus}
          disabled={disabled}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      </Input.Wrapper>
    </Input.Root>
  );
}

function SecuritySelect({ id, value, onChange, label }: { id: string; value: Security; onChange: (value: Security) => void; label: string }) {
  return (
    <Select.Root size="medium" value={value} onValueChange={(next) => onChange(next as Security)}>
      <Select.Trigger id={id} aria-label={label}>
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="tls">SSL/TLS</Select.Item>
        <Select.Item value="starttls">STARTTLS</Select.Item>
      </Select.Content>
    </Select.Root>
  );
}

/** One server's host, port and security on a row. */
function ServerFields({
  idPrefix,
  title,
  host,
  port,
  security,
  onHost,
  onPort,
  onSecurity,
  placeholder,
}: {
  idPrefix: string;
  title: string;
  host: string;
  port: string;
  security: Security;
  onHost: (value: string) => void;
  onPort: (value: string) => void;
  onSecurity: (value: Security) => void;
  placeholder: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_5.5rem_8.5rem]">
      <Field label={`${title} server`} htmlFor={`${idPrefix}-host`} required>
        <TextInput id={`${idPrefix}-host`} value={host} onChange={onHost} placeholder={placeholder} required />
      </Field>
      <Field label="Port" htmlFor={`${idPrefix}-port`} required>
        <TextInput id={`${idPrefix}-port`} type="number" value={port} onChange={onPort} required />
      </Field>
      <Field label="Security" htmlFor={`${idPrefix}-security`}>
        <SecuritySelect id={`${idPrefix}-security`} value={security} onChange={onSecurity} label={`${title} security`} />
      </Field>
    </div>
  );
}

/**
 * Adds a mailbox and tests it in one step: a Google Workspace address (our
 * service account impersonates it) or any other provider over SMTP + IMAP
 * with the mailbox's own login. With `edit`, changes an SMTP + IMAP
 * mailbox's servers or password instead. An AlignUI (Radix) modal, so it
 * stacks correctly over the Settings pop-up: focus, Escape and outside-click
 * all belong to the top dialog.
 */
export default function ConnectMailboxDialog({
  onClose,
  googleConnected,
  edit,
}: {
  onClose: () => void;
  /** Google Workspace is connected, so a Google mailbox can be added. */
  googleConnected: boolean;
  edit?: EditImapMailbox;
}) {
  const router = useRouter();
  const [provider, setProvider] = useState<Provider>(edit || !googleConnected ? "imap" : "google");
  const [emailAddress, setEmailAddress] = useState(edit?.emailAddress ?? "");
  const [displayName, setDisplayName] = useState(edit?.displayName ?? "");
  const [signatureHtml, setSignatureHtml] = useState("");

  const initial = edit?.settings;
  const [presetKey, setPresetKey] = useState(
    initial ? IMAP_SMTP_PRESETS.find((p) => p.smtpHost === initial.smtpHost && p.imapHost === initial.imapHost)?.key ?? CUSTOM : CUSTOM,
  );
  const [username, setUsername] = useState(initial?.username ?? "");
  const [usernameTouched, setUsernameTouched] = useState(Boolean(initial));
  const [password, setPassword] = useState("");
  const [smtpHost, setSmtpHost] = useState(initial?.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = useState(String(initial?.smtpPort ?? 465));
  const [smtpSecurity, setSmtpSecurity] = useState<Security>(initial?.smtpSecurity ?? "tls");
  const [imapHost, setImapHost] = useState(initial?.imapHost ?? "");
  const [imapPort, setImapPort] = useState(String(initial?.imapPort ?? 993));
  const [imapSecurity, setImapSecurity] = useState<Security>(initial?.imapSecurity ?? "tls");
  const [saveToSent, setSaveToSent] = useState(initial ? initial.sentFolder !== null : true);

  const [stage, setStage] = useState<Stage>("form");
  const [error, setError] = useState<string | null>(null);

  const preset = imapSmtpPreset(presetKey);

  function choosePreset(key: string) {
    setPresetKey(key);
    const next = imapSmtpPreset(key);
    if (!next) return;
    setSmtpHost(next.smtpHost);
    setSmtpPort(String(next.smtpPort));
    setSmtpSecurity(next.smtpSecurity);
    setImapHost(next.imapHost);
    setImapPort(String(next.imapPort));
    setImapSecurity(next.imapSecurity);
    setSaveToSent(!next.serverSavesSent);
  }

  function changeEmail(value: string) {
    setEmailAddress(value);
    // The username is nearly always the address itself; follow it until edited.
    if (!usernameTouched) setUsername(value.trim());
  }

  /** Port 465/993 mean TLS from the start; 587/143 mean STARTTLS. */
  function portWithSecurity(value: string, set: (port: string) => void, setSecurity: (s: Security) => void) {
    set(value);
    if (value === "465" || value === "993") setSecurity("tls");
    if (value === "587" || value === "143" || value === "25") setSecurity("starttls");
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setStage("testing");
    setError(null);
    try {
      const res = await fetch("/api/outreach/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailAddress,
          displayName: displayName || undefined,
          signatureHtml: edit ? undefined : signatureHtml || undefined,
          provider,
          ...(provider === "imap"
            ? {
                imapSmtp: {
                  smtpHost,
                  smtpPort: Number(smtpPort),
                  smtpSecurity,
                  imapHost,
                  imapPort: Number(imapPort),
                  imapSecurity,
                  username,
                  password: password || undefined,
                  saveToSent,
                },
              }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setError(data.error ?? "Failed to connect mailbox");
        setStage("failed");
        return;
      }
      setStage("success");
      router.refresh();
    } catch {
      setError("Network error — please try again");
      setStage("failed");
    }
  }

  const testing = stage === "testing";
  const imapReady = Boolean(username && (password || edit) && smtpHost && smtpPort && imapHost && imapPort);
  const canSubmit = Boolean(emailAddress) && (provider === "google" || imapReady);

  return (
    <Modal.Root open onOpenChange={(open) => { if (!open && !testing) onClose(); }}>
      <Modal.Content size="max-w-xl" hideClose={testing} onEscapeKeyDown={(event) => testing && event.preventDefault()}>
        <Modal.Header icon={edit ? RiMailSettingsLine : RiMailAddLine}>
          <Modal.Title>{edit ? "Change SMTP / IMAP login" : "Add a mailbox"}</Modal.Title>
          <Modal.Description>
            {edit
              ? `New servers or password for ${edit.emailAddress}. Both are tested before anything changes.`
              : provider === "google"
                ? "A Google Workspace address already authorised for sending. It is tested before it is saved."
                : "Any provider with SMTP and IMAP: SMTP sends, IMAP reads the replies. Both are tested before it is saved."}
          </Modal.Description>
          <DocsLink page="email/connect#add-a-mailbox" appearance="inline" className="mt-1.5 text-paragraph-xs" />
        </Modal.Header>

        {(stage === "form" || stage === "failed") && (
          <form onSubmit={handleConnect} className="flex min-h-0 flex-col">
            <Modal.Body className="space-y-4">
              {!edit && (
                <SegmentedControl.Root value={provider} onValueChange={(value) => setProvider(value as Provider)}>
                  <SegmentedControl.List className="w-full auto-cols-fr">
                    <SegmentedControl.Trigger value="google" disabled={!googleConnected} title={googleConnected ? undefined : "Connect Google Workspace in Settings → Email → Connection first"}>
                      Google Workspace
                    </SegmentedControl.Trigger>
                    <SegmentedControl.Trigger value="imap">Other provider (SMTP + IMAP)</SegmentedControl.Trigger>
                  </SegmentedControl.List>
                </SegmentedControl.Root>
              )}

              <Field
                label="Email address"
                htmlFor="mailbox-email"
                required
                description={
                  provider === "google"
                    ? "Must be authorised for our app's client ID in the Workspace admin console (domain-wide delegation)."
                    : edit
                      ? undefined
                      : "The address campaigns send from."
                }
              >
                <TextInput
                  id="mailbox-email"
                  type="email"
                  required
                  autoFocus={!edit}
                  disabled={Boolean(edit)}
                  value={emailAddress}
                  onChange={changeEmail}
                  placeholder="rep@yourcompany.com"
                />
              </Field>

              {provider === "imap" && (
                <>
                  <Field label="Provider" htmlFor="mailbox-preset" description="Fills in the servers below. Pick Other for your own mail server or hosting.">
                    <Select.Root size="medium" value={presetKey} onValueChange={choosePreset}>
                      <Select.Trigger id="mailbox-preset" aria-label="Provider">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        {IMAP_SMTP_PRESETS.map((p) => (
                          <Select.Item key={p.key} value={p.key}>{p.name}</Select.Item>
                        ))}
                        <Select.Item value={CUSTOM}>Other (enter the servers)</Select.Item>
                      </Select.Content>
                    </Select.Root>
                  </Field>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Username" htmlFor="mailbox-username" required>
                      <TextInput
                        id="mailbox-username"
                        value={username}
                        onChange={(value) => {
                          setUsername(value);
                          setUsernameTouched(true);
                        }}
                        placeholder="Usually the email address"
                        autoComplete="off"
                        required
                      />
                    </Field>
                    <Field label="Password" htmlFor="mailbox-password" required={!edit} optional={Boolean(edit)}>
                      <TextInput
                        id="mailbox-password"
                        type="password"
                        value={password}
                        onChange={setPassword}
                        placeholder={edit ? "Leave empty to keep the saved one" : "App password"}
                        autoComplete="new-password"
                        required={!edit}
                      />
                    </Field>
                  </div>
                  <p className="-mt-2 text-paragraph-xs text-text-sub-600">
                    {preset?.passwordHint ??
                      "Most providers want an app password here rather than the account's own, especially with two-factor sign-in. It is stored encrypted and only used to send and read this mailbox."}
                  </p>

                  <ServerFields
                    idPrefix="mailbox-smtp"
                    title="SMTP"
                    host={smtpHost}
                    port={smtpPort}
                    security={smtpSecurity}
                    onHost={(value) => { setSmtpHost(value); setPresetKey(CUSTOM); }}
                    onPort={(value) => portWithSecurity(value, setSmtpPort, setSmtpSecurity)}
                    onSecurity={setSmtpSecurity}
                    placeholder="smtp.yourprovider.com"
                  />
                  <ServerFields
                    idPrefix="mailbox-imap"
                    title="IMAP"
                    host={imapHost}
                    port={imapPort}
                    security={imapSecurity}
                    onHost={(value) => { setImapHost(value); setPresetKey(CUSTOM); }}
                    onPort={(value) => portWithSecurity(value, setImapPort, setImapSecurity)}
                    onSecurity={setImapSecurity}
                    placeholder="imap.yourprovider.com"
                  />

                  <label htmlFor="mailbox-save-sent" className="flex cursor-pointer items-start gap-2">
                    <Checkbox.Root id="mailbox-save-sent" className="mt-0.5" checked={saveToSent} onCheckedChange={(checked) => setSaveToSent(checked === true)} />
                    <span>
                      <span className="block text-label-sm text-text-strong-950">Save a copy of each email to the Sent folder</span>
                      <span className="block text-paragraph-xs text-text-sub-600">
                        So sends show up in the mailbox&apos;s own mail app. Turn it off if the provider already files SMTP sends (Gmail and Microsoft do), or each would appear twice.
                      </span>
                    </span>
                  </label>
                </>
              )}

              <Field label="Display name" htmlFor="mailbox-name" optional description="The name recipients see beside the address.">
                <TextInput id="mailbox-name" value={displayName} onChange={setDisplayName} placeholder="Jane from Acme" />
              </Field>

              {!edit && (
                <Field
                  label="Signature"
                  htmlFor="mailbox-signature"
                  optional
                  description="Appended to every send from this mailbox. You can change it later from the mailbox's Signature action."
                >
                  <Textarea.Root
                    id="mailbox-signature"
                    simple
                    value={signatureHtml}
                    onChange={(e) => setSignatureHtml(e.target.value)}
                    placeholder={"Jane Doe\nHead of Sales, Acme Inc."}
                    rows={4}
                  />
                </Field>
              )}

              {stage === "failed" && error && (
                <Callout tone="error" title="The connection test failed">
                  {error}
                </Callout>
              )}
            </Modal.Body>

            <Modal.Footer>
              <Button.Root type="button" variant="neutral" mode="stroke" size="small" onClick={onClose}>
                Cancel
              </Button.Root>
              <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={!canSubmit}>
                {stage === "failed" ? "Try again" : edit ? "Test & save" : "Connect & test"}
              </Button.Root>
            </Modal.Footer>
          </form>
        )}

        {testing && (
          <Modal.Body>
            <div role="status" className="flex flex-col items-center justify-center gap-3 py-10 text-center">
              <RiLoader4Line className="size-6 animate-spin text-text-sub-600" aria-hidden="true" />
              <p className="text-paragraph-sm text-text-sub-600">
                {provider === "imap" ? `Signing in to ${smtpHost || "SMTP"} and ${imapHost || "IMAP"} as ${username}…` : `Testing the connection to ${emailAddress}…`}
              </p>
            </div>
          </Modal.Body>
        )}

        {stage === "success" && (
          <>
            <Modal.Body>
              <div role="status" className="flex flex-col items-center justify-center gap-3 py-6 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-success-lighter">
                  <RiCheckLine className="size-6 text-success-base" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-label-sm text-text-strong-950">{edit ? "Login updated" : "Mailbox connected"}</p>
                  <p className="mt-0.5 text-paragraph-sm text-text-sub-600">
                    {emailAddress} is ready to send{provider === "imap" ? ", and replies are checked every two minutes" : ""}.
                  </p>
                </div>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button.Root variant="primary" mode="filled" size="small" onClick={onClose}>
                Done
              </Button.Root>
            </Modal.Footer>
          </>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}
