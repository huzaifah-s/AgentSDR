"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { AuthShell } from "@/components/auth/AuthShell";
import { ErrorCallout, Field, InfoCallout, SecondaryButton, SubmitButton, linkClass, quietLinkClass } from "@/components/auth/fields";
import { GoogleButton, OrDivider } from "@/components/auth/GoogleButton";

// Fork: invite requests go to this deployment's admin, not upstream's founder.
// Set NEXT_PUBLIC_ACCESS_REQUEST_EMAIL; unset, the mail opens with no recipient.
const ACCESS_REQUEST_TO = process.env.NEXT_PUBLIC_ACCESS_REQUEST_EMAIL ?? "";

/** A mailto asking this deployment's admin for an invite, carrying the email typed into the form when there is one. */
function accessRequestHref(email: string) {
  const body = [
    "Hi,",
    "",
    "Could you send me an invite to BraintreeSDR?",
    "",
    `Work email: ${email.trim()}`,
  ].join("\n");
  const subject = "Invite to BraintreeSDR";
  return `mailto:${ACCESS_REQUEST_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function oauthContinuation(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const { redirect, url } = data as { redirect?: unknown; url?: unknown };
  return redirect === true && typeof url === "string" && url ? url : null;
}

export function SignInForm({
  googleEnabled,
  from,
  signupAvailable = true,
}: {
  googleEnabled: boolean;
  from: string | null;
  /** False on an invite-only instance: accounts come from invitations, so "Create one" is not offered. */
  signupAvailable?: boolean;
}) {
  const target = from || "/analytics";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setUnverified(false);
    setResent(false);
    setLoading(true);
    const { data, error: err } = await authClient.signIn.email({ email, password, callbackURL: target });
    if (!err) {
      // Signing in during an OAuth authorization (an MCP client connecting):
      // the response names where the flow continues (choose an organization,
      // consent, or back to the client), and Better Auth's client is already
      // navigating there. Going to `target` too would cut the flow off.
      if (oauthContinuation(data)) return;
      window.location.href = target;
      return;
    }
    if (err.code === "EMAIL_NOT_VERIFIED") setUnverified(true);
    else if (err.code === "INVALID_EMAIL_OR_PASSWORD") setError("Incorrect email or password.");
    else setError(err.message || "Something went wrong. Please try again.");
    setLoading(false);
  }

  async function resend() {
    setResending(true);
    const { error: err } = await authClient.sendVerificationEmail({ email, callbackURL: target });
    setResending(false);
    if (err) setError(err.message || "Could not send the email. Please try again.");
    else setResent(true);
  }

  const q = from ? `?from=${encodeURIComponent(from)}` : "";

  return (
    <AuthShell
      title="Sign in to BraintreeSDR"
      footer={
        signupAvailable ? (
          <>
            Don&apos;t have an account?{" "}
            <Link href={`/sign-up${q}`} className={linkClass}>
              Create one
            </Link>
          </>
        ) : (
          <>
            Need access?{" "}
            <a href={accessRequestHref(email)} className={linkClass}>
              Ask your admin for an invite
            </a>
          </>
        )
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field
          label="Work email"
          type="email"
          autoComplete="email"
          placeholder="name@company.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          labelAside={
            <Link href="/forgot-password" className={quietLinkClass}>
              Forgot password?
            </Link>
          }
          type="password"
          autoComplete="current-password"
          placeholder="Enter your password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <ErrorCallout>{error}</ErrorCallout>}
        {unverified && (
          <div className="flex flex-col gap-3">
            <ErrorCallout>Your email address isn&apos;t verified yet. Check your inbox for the confirmation link.</ErrorCallout>
            {resent ? (
              <InfoCallout>Verification email sent. It can take a minute to arrive.</InfoCallout>
            ) : (
              <SecondaryButton onClick={resend} loading={resending} disabled={!email}>
                Resend verification email
              </SecondaryButton>
            )}
          </div>
        )}
        <div className="pt-1">
          <SubmitButton loading={loading} loadingLabel="Signing in...">
            Sign in
          </SubmitButton>
        </div>
      </form>
      {googleEnabled && (
        <>
          <OrDivider label="Or continue with" />
          <GoogleButton callbackURL={target} onError={setError} label="Google" />
        </>
      )}
    </AuthShell>
  );
}
