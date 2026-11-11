"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RiBuilding2Line, RiCheckboxCircleLine, RiEditLine, RiErrorWarningLine, RiExternalLinkLine, RiHistoryLine, RiLinkedinBoxLine, RiMailLine, RiPhoneLine, RiUserSearchLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Modal from "@/components/alignui/modal";
import { CallButton } from "@/components/calls/CallButton";
import { Avatar } from "@/components/calling/callingShared";
import { errorMessage, formatDate } from "@/components/crm/crm-utils";
import { Skeleton } from "@/components/page/Skeletons";
import { PersonWhatsappPanel } from "@/components/whatsapp/PersonWhatsappPanel";
import { listCalls } from "@/lib/calls/client";
import type { PersonActivityEvent } from "@/lib/leads/personActivity";
import { cn } from "@/utils/cn";
import { linkedInPersonHref, type PersonRow } from "./leadTypes";
import { personActivityItems, type PersonActivityItem } from "./personActivityItems";

async function loadPersonActivity(personId: string): Promise<PersonActivityItem[]> {
  const [calls, events] = await Promise.all([
    listCalls(personId).then((body) => body.calls),
    fetch(`/api/leads/people/${encodeURIComponent(personId)}/activity`).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Unable to load activity");
      return body.events as PersonActivityEvent[];
    }),
  ]);
  return personActivityItems(calls, events);
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-stroke-soft-200 pt-5 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-label-sm text-text-strong-950">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function DetailLine({ icon: Icon, label, children }: { icon: typeof RiMailLine; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <dt><Icon className="size-4 shrink-0 text-text-soft-400" aria-label={label} /></dt>
      <dd className="min-w-0 truncate text-text-sub-600">{children}</dd>
    </div>
  );
}

function ActivityList({ items }: { items: PersonActivityItem[] }) {
  if (!items.length) {
    return <p className="rounded-xl bg-bg-weak-50 px-3 py-4 text-center text-paragraph-sm text-text-sub-600">Nothing yet. Calls, messages and logged updates show here.</p>;
  }
  return (
    <ol className="divide-y divide-stroke-soft-200 rounded-xl ring-1 ring-inset ring-stroke-soft-200">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-3 px-3 py-2.5">
          <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", item.failed ? "bg-error-lighter text-error-base" : "bg-bg-weak-50 text-text-soft-400")}>
            {item.kind === "call" ? <RiPhoneLine className="size-3.5" aria-hidden="true" /> : item.failed ? <RiErrorWarningLine className="size-3.5" aria-hidden="true" /> : <RiCheckboxCircleLine className="size-3.5" aria-hidden="true" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-label-sm text-text-strong-950">{item.title}</p>
            {item.detail && <p className="mt-0.5 whitespace-pre-line break-words text-paragraph-xs text-text-sub-600">{item.detail}</p>}
          </div>
          <time dateTime={item.at} className="shrink-0 text-paragraph-xs text-text-soft-400">{formatDate(item.at)}</time>
        </li>
      ))}
    </ol>
  );
}

/**
 * A person on the Leads page, worked one at a time: their details, what has
 * happened with them, and the ways to reach them that need no campaign.
 * People with a CRM record still open the record; this is for everyone else
 * (and for anyone, from the row menu).
 */
export function PersonDrawer({ row, onClose, onEdit, onChanged }: {
  row: PersonRow;
  onClose: () => void;
  onEdit?: (row: PersonRow) => void;
  /** Something about the person changed (a call started, a message went out): the list refreshes. */
  onChanged?: () => void;
}) {
  const { person, company, crm } = row;
  const name = person.fullName || [person.firstName, person.lastName].filter(Boolean).join(" ") || "Unnamed person";
  const companyName = company ? company.name || company.domain : null;
  const subtitle = [person.title, companyName].filter(Boolean).join(" at ") || person.email || person.phone || undefined;

  const [items, setItems] = useState<PersonActivityItem[] | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++request.current;
    try {
      const next = await loadPersonActivity(person.id);
      if (mine === request.current) { setItems(next); setError(""); }
    } catch (cause) {
      if (mine === request.current) setError(errorMessage(cause));
    }
  }, [person.id]);
  useEffect(() => { void reload(); }, [reload]);

  const changed = () => { void reload(); onChanged?.(); };

  return (
    <Modal.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.SideContent size="max-w-xl">
        <Modal.Header>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar name={name} src={person.profilePictureUrl} className="size-10 text-label-sm" />
              <div className="min-w-0">
                <Modal.Title className="truncate">{name}</Modal.Title>
                {subtitle && <Modal.Description className="mt-0.5 truncate">{subtitle}</Modal.Description>}
              </div>
            </div>
            {onEdit && (
              <Button.Root variant="neutral" mode="ghost" size="xsmall" className="shrink-0" onClick={() => onEdit(row)}>
                <Button.Icon as={RiEditLine} />Edit
              </Button.Root>
            )}
          </div>
        </Modal.Header>
        <Modal.Body className="space-y-5">
          <Section title="Details">
            <dl className="space-y-1.5 rounded-xl bg-bg-weak-50 p-3 text-paragraph-sm ring-1 ring-inset ring-stroke-soft-200">
              <DetailLine icon={RiMailLine} label="Email">{person.email ? <a href={`mailto:${person.email}`} className="hover:underline">{person.email}</a> : <span className="text-text-soft-400">No email</span>}</DetailLine>
              <DetailLine icon={RiPhoneLine} label="Phone">{person.phone ? <span className="tabular-nums text-text-strong-950">{person.phone}</span> : <span className="text-text-soft-400">No phone number</span>}</DetailLine>
              {person.linkedinUrl && (
                <DetailLine icon={RiLinkedinBoxLine} label="LinkedIn">
                  <a href={linkedInPersonHref(person.linkedinUrl)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">LinkedIn profile<RiExternalLinkLine className="size-3.5" aria-hidden="true" /></a>
                </DetailLine>
              )}
              {company && <DetailLine icon={RiBuilding2Line} label="Company">{companyName}{company.name && company.name !== company.domain ? <span className="text-text-soft-400"> · {company.domain}</span> : null}</DetailLine>}
            </dl>
            {crm && (
              <Button.Root asChild variant="neutral" mode="stroke" size="xsmall">
                <Link href={`/crm/records/${crm.recordId}`}><Button.Icon as={RiUserSearchLine} />Open CRM record</Link>
              </Button.Root>
            )}
          </Section>

          <Section title="Reach out">
            <div className="flex flex-wrap items-center gap-2">
              <CallButton personId={person.id} crmRecordId={crm?.recordId ?? null} phone={person.phone ?? null} onCallStarted={changed} />
            </div>
          </Section>

          <Section title="WhatsApp">
            <PersonWhatsappPanel personId={person.id} onSent={changed} heightClass="h-60" />
          </Section>

          <Section title="Activity" aside={<RiHistoryLine className="size-4 text-text-soft-400" aria-hidden="true" />}>
            {error && <p role="alert" className="text-paragraph-xs text-error-base">Couldn&apos;t load activity: {error}</p>}
            {items ? <ActivityList items={items} /> : !error && <div aria-busy="true" aria-label="Loading activity" className="space-y-2"><Skeleton className="h-12 w-full rounded-xl" /><Skeleton className="h-12 w-full rounded-xl" /></div>}
          </Section>
        </Modal.Body>
      </Modal.SideContent>
    </Modal.Root>
  );
}
