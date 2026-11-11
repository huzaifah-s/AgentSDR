import { CALL_STATUS_LABEL } from "@/components/calls/callStatus";
import { formatCallDuration } from "@/components/calls/formatElapsed";
import { CALL_DISPOSITION_DEFINITIONS, type CallSummary } from "@/lib/calls/contract";
import type { PersonActivityEvent } from "@/lib/leads/personActivity";

/** One line of the person drawer's Activity list. */
export type PersonActivityItem = {
  id: string;
  kind: "call" | "event";
  at: string;
  title: string;
  detail: string | null;
  failed: boolean;
};

const EVENT_LABELS: Record<string, string> = {
  "manual_email.sent": "Email sent",
  "record.created": "CRM record created",
  "reply.received": "Reply received",
  "message.recorded": "Message sent outside AgentSDR",
  "message.sent": "Message delivered",
  "message.failed": "Message failed",
  "contact_policy.dnc_set": "Do Not Contact enabled",
  "contact_policy.dnc_cleared": "Do Not Contact cleared",
  "workflow.state_changed": "Workflow updated",
};

const humanize = (value: string) => value.replace(/[._]/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

function callItem(call: CallSummary): PersonActivityItem {
  const who = (call.mode === "agent" || call.mode === "agent_cloud") && !call.remoteRep ? "AI agent call" : "Call";
  const duration = formatCallDuration(call.durationMs);
  const disposition = call.disposition ? CALL_DISPOSITION_DEFINITIONS[call.disposition]?.label : null;
  return {
    id: `call:${call.id}`,
    kind: "call",
    at: call.startedAt ?? call.createdAt,
    title: `${who} · ${CALL_STATUS_LABEL[call.status] ?? humanize(call.status)}`,
    detail: [call.phone, duration, disposition, call.error].filter(Boolean).join(" · ") || null,
    failed: call.status === "failed",
  };
}

function eventItem(event: PersonActivityEvent): PersonActivityItem {
  const meta = event.meta ?? {};
  return {
    id: `event:${event.id}`,
    kind: "event",
    at: text(meta.occurredAt) ?? event.createdAt,
    title: EVENT_LABELS[event.eventType] ?? humanize(event.eventType),
    detail: event.eventType === "manual_email.sent"
      ? [text(meta.subject) && `“${text(meta.subject)}”`, text(meta.from) && `from ${text(meta.from)}`].filter(Boolean).join(" ") || null
      : text(meta.summary) ?? text(meta.reason) ?? text(meta.error),
    failed: /failed|error|uncertain/.test(event.eventType),
  };
}

/** Calls and CRM events in one list, newest first. Pure, for the tests. */
export function personActivityItems(calls: CallSummary[], events: PersonActivityEvent[]): PersonActivityItem[] {
  return [...calls.map(callItem), ...events.map(eventItem)]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
