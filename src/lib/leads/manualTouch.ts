import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { lockRepresentativeRecord } from "@/lib/calls/leadStage";
import { appendCrmEvent, type CrmEventActor } from "@/lib/crm/events";
import { getOrCreateCrmRecordForManualActivity, lockCrmRecord, type CrmRecord } from "@/lib/crm/records";
import { withCrmTransaction, type CrmTransaction } from "@/lib/crm/repository";
import { crmRecords, type CrmRecordChannel } from "@/lib/crm/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { people } from "./schema";

/**
 * Reaching a person by hand from Leads, and what the rep logs about it.
 *
 * The first manual touch — a one-off email or a logged update — gives the
 * person a CRM record, as a first call does (getOrCreateCrmRecordForManualActivity),
 * so they show in the Pipeline and can carry a follow-up date. An update is a
 * `crm_events` row (`activity.logged`); no table or CRM channel is added.
 */

export const ACTIVITY_LOGGED_EVENT = "activity.logged";

export const LOGGED_ACTIVITY_KINDS = ["call", "whatsapp", "email", "linkedin", "meeting", "note"] as const;
export type LoggedActivityKind = (typeof LOGGED_ACTIVITY_KINDS)[number];
export type LoggedActivityDirection = "outbound" | "inbound";

/** The record channel a logged update's follow-up is due on; null for a meeting or note. */
const KIND_CHANNEL: Record<LoggedActivityKind, CrmRecordChannel | null> = {
  call: "whatsapp",
  whatsapp: "whatsapp",
  email: "email",
  linkedin: "linkedin",
  meeting: null,
  note: null,
};

export const MAX_SUMMARY_LENGTH = 5_000;
/** How far ahead of now an update may be dated, for clock skew between browser and server. */
const FUTURE_SLACK_MS = 5 * 60_000;

export class ManualTouchError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "ManualTouchError";
  }
}

export type LoggedUpdate = {
  kind: LoggedActivityKind;
  direction: LoggedActivityDirection;
  occurredAt: Date;
  summary: string;
  followUpAt: Date | null;
};

function parseDate(value: unknown, label: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ManualTouchError(400, `${label} must be a date`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ManualTouchError(400, `${label} is not a valid date`);
  return date;
}

/** The Log an update form, validated. Pure, for the tests. */
export function normalizeLoggedUpdate(input: Record<string, unknown>, now: Date): LoggedUpdate {
  const kind = input.kind;
  if (typeof kind !== "string" || !(LOGGED_ACTIVITY_KINDS as readonly string[]).includes(kind)) {
    throw new ManualTouchError(400, "Choose what happened: call, WhatsApp, email, LinkedIn, meeting or note");
  }
  const direction = input.direction === "inbound" ? "inbound" : input.direction === "outbound" || input.direction === undefined ? "outbound" : null;
  if (!direction) throw new ManualTouchError(400, "Direction must be outbound or inbound");
  const summary = typeof input.summary === "string" ? input.summary.replace(/\r\n/g, "\n").trim() : "";
  if (!summary) throw new ManualTouchError(400, "Write a short summary of what happened");
  if (summary.length > MAX_SUMMARY_LENGTH) throw new ManualTouchError(400, `Summary is too long (at most ${MAX_SUMMARY_LENGTH.toLocaleString("en-US")} characters)`);
  const occurredAt = parseDate(input.occurredAt, "When") ?? now;
  if (occurredAt.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new ManualTouchError(400, "An update cannot be dated in the future");
  const followUpAt = parseDate(input.followUpAt, "Next follow-up");
  if (followUpAt && followUpAt.getTime() <= now.getTime()) throw new ManualTouchError(400, "The next follow-up must be in the future");
  return { kind: kind as LoggedActivityKind, direction, occurredAt, summary, followUpAt };
}

export type ManualFollowUpState = Pick<CrmRecord, "workflowState" | "nextActionAt" | "activeChannel" | "latestInboundMessageId">;

export type ManualFollowUpDecision =
  | { apply: true; update: { workflowState: "waiting"; nextActionAt: Date; activeChannel: CrmRecordChannel | null } }
  | { apply: false; reason: string };

/**
 * Whether a logged follow-up date can go on the record. Pure, for the tests.
 *
 * It follows the call path (calls/crmFollowUp.ts callFollowUpUpdate):
 * "waiting" with a date is how the CRM holds a scheduled follow-up, and
 * Action required lists it once due. Only a record with no inbound reply
 * takes one — a reply's sequence owns that record's follow-ups — and only an
 * idle or waiting record moves; one that needs a person for another reason,
 * or is paused or closed, keeps its state.
 */
export function manualFollowUpDecision(record: ManualFollowUpState, dueAt: Date, kind: LoggedActivityKind): ManualFollowUpDecision {
  if (record.latestInboundMessageId) {
    return { apply: false, reason: "This person has a reply in the CRM, so its sequence handles their follow-ups. Set the date on the CRM record instead." };
  }
  if (record.workflowState !== "idle" && record.workflowState !== "waiting") {
    return { apply: false, reason: `The CRM record is ${record.workflowState.replace(/_/g, " ")}, so its follow-up date was left as it is.` };
  }
  return {
    apply: true,
    update: { workflowState: "waiting", nextActionAt: dueAt, activeChannel: record.activeChannel ?? KIND_CHANNEL[kind] },
  };
}

/** The person's CRM record, locked — the one Calling uses — created at this first manual touch when they have none. */
export async function lockOrCreateManualRecord(
  tx: CrmTransaction,
  personId: string,
  actor: { actorType: CrmEventActor; actorRef?: string | null },
): Promise<{ record: CrmRecord; created: boolean }> {
  const existing = await lockRepresentativeRecord(tx, personId);
  const { record, created } = existing
    ? { record: existing, created: false }
    : await getOrCreateCrmRecordForManualActivity(tx, { personId, cause: "first_manual_touch", ...actor });
  const locked = existing ?? await lockCrmRecord(tx, record.id);
  // A new record starts "unclassified", which the CRM reads as a reply being
  // classified. With no reply there is nothing pending: it is idle. A direct
  // write (as calls/crmFollowUp.ts does), since the state machine keeps
  // unclassified → idle for the reply path.
  if (locked.workflowState !== "unclassified" || locked.latestInboundMessageId) return { record: locked, created };
  const contextVersion = locked.contextVersion + 1;
  const [idle] = await tx.update(crmRecords)
    .set({ workflowState: "idle", contextVersion, updatedAt: new Date() })
    .where(and(inOrg(crmRecords), eq(crmRecords.id, locked.id)))
    .returning();
  await appendCrmEvent(tx, {
    personId: locked.personId,
    crmRecordId: locked.id,
    pipelineId: locked.pipelineId,
    eventType: "workflow.state_changed",
    ...actor,
    fromData: { workflowState: locked.workflowState },
    toData: { workflowState: "idle" },
    meta: { reason: "Reached by hand from Leads; no reply to classify" },
    contextVersion,
  });
  return { record: idle ?? { ...locked, workflowState: "idle", contextVersion }, created };
}

const later = (current: Date | null, next: Date) => (current && current.getTime() > next.getTime() ? current : next);

export type LogManualActivityResult = {
  eventId: string;
  crmRecordId: string;
  recordCreated: boolean;
  followUp: { scheduled: true; at: string } | { scheduled: false; reason: string } | null;
};

/**
 * Keeps one logged update on the person's CRM record (creating the record at
 * this first touch) and, when it carries a follow-up date the record can
 * take, schedules it. The record's last interaction moves to the update's
 * time; its inbound/outbound times do not, because those decide whether a
 * reply in the CRM has been answered.
 */
export async function logManualActivity(input: {
  personId: string;
  update: LoggedUpdate;
  actorRef: string | null;
}): Promise<LogManualActivityResult> {
  const [person] = await db.select({ id: people.id }).from(people).where(and(inOrg(people), eq(people.id, input.personId))).limit(1);
  if (!person) throw new ManualTouchError(404, "Person not found");
  const { update } = input;
  const actor = { actorType: "human" as const, actorRef: input.actorRef };

  return withCrmTransaction(async (tx) => {
    const { record, created } = await lockOrCreateManualRecord(tx, person.id, actor);
    const event = await appendCrmEvent(tx, {
      personId: person.id,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: ACTIVITY_LOGGED_EVENT,
      ...actor,
      meta: {
        kind: update.kind,
        direction: update.direction,
        summary: update.summary,
        occurredAt: update.occurredAt.toISOString(),
        followUpAt: update.followUpAt?.toISOString() ?? null,
      },
      contextVersion: record.contextVersion,
    });

    let followUp: LogManualActivityResult["followUp"] = null;
    let contextVersion = record.contextVersion;
    const set: Partial<typeof crmRecords.$inferInsert> = { lastInteractionAt: later(record.lastInteractionAt, update.occurredAt) };
    if (update.followUpAt) {
      const decision = manualFollowUpDecision(record, update.followUpAt, update.kind);
      if (decision.apply) {
        contextVersion += 1;
        Object.assign(set, decision.update, { contextVersion });
        followUp = { scheduled: true, at: update.followUpAt.toISOString() };
      } else {
        followUp = { scheduled: false, reason: decision.reason };
      }
    }
    // A direct write, as calls/crmFollowUp.ts does: transitionWorkflow does
    // not allow idle → waiting, which only sequences and calls produce.
    await tx.update(crmRecords).set({ ...set, updatedAt: new Date() }).where(and(inOrg(crmRecords), eq(crmRecords.id, record.id)));
    if (followUp?.scheduled) {
      await appendCrmEvent(tx, {
        personId: person.id,
        crmRecordId: record.id,
        pipelineId: record.pipelineId,
        eventType: "workflow.state_changed",
        ...actor,
        fromData: { workflowState: record.workflowState, nextActionAt: record.nextActionAt },
        toData: { workflowState: "waiting", nextActionAt: update.followUpAt },
        meta: { reason: "Follow-up set from a logged update" },
        contextVersion,
      });
    }
    return { eventId: event.id, crmRecordId: record.id, recordCreated: created, followUp };
  });
}
