import type { Metadata } from "next";
import { SettingsShell } from "@/components/settings/SettingsShell";

export const metadata: Metadata = {
  title: {
    default: "Settings · Braintree Reach",
    template: "%s · Settings · Braintree Reach",
  },
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>;
}
