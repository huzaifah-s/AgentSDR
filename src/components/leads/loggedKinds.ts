/** What a logged update can be, as the Log an update form offers it (the API's kinds: src/lib/leads/manualTouch.ts). */
export const LOGGED_KINDS = [
  { value: "call", label: "Call" },
  { value: "whatsapp", label: "WhatsApp (my phone)" },
  { value: "email", label: "Email (my own inbox)" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "meeting", label: "Meeting" },
  { value: "note", label: "Note" },
] as const;

export const LOGGED_KIND_LABELS: Record<string, string> = Object.fromEntries(LOGGED_KINDS.map((kind) => [kind.value, kind.label]));
