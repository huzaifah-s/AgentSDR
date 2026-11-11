import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmEvents } from "@/lib/crm/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { people } from "./schema";

/** One `crm_events` row as the Leads person drawer lists it. */
export type PersonActivityEvent = {
  id: string;
  eventType: string;
  actorType: string;
  actorRef: string | null;
  crmRecordId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

const LIMIT = 100;

/**
 * The person's CRM events, newest first — with or without a CRM record, so a
 * logged update or a one-off email shows before any reply has created one.
 * Null when the person is not this organization's (the route's 404).
 */
export async function listPersonActivity(personId: string): Promise<PersonActivityEvent[] | null> {
  const [person] = await db.select({ id: people.id }).from(people).where(and(inOrg(people), eq(people.id, personId))).limit(1);
  if (!person) return null;
  const rows = await db
    .select({
      id: crmEvents.id,
      eventType: crmEvents.eventType,
      actorType: crmEvents.actorType,
      actorRef: crmEvents.actorRef,
      crmRecordId: crmEvents.crmRecordId,
      meta: crmEvents.meta,
      createdAt: crmEvents.createdAt,
    })
    .from(crmEvents)
    .where(and(inOrg(crmEvents), eq(crmEvents.personId, personId)))
    .orderBy(desc(crmEvents.createdAt))
    .limit(LIMIT);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}
