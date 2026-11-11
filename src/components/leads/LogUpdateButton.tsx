"use client";

import { useState } from "react";
import { RiStickyNoteAddLine } from "@remixicon/react";
import * as Modal from "@/components/alignui/modal";
import { subtleButtonClass } from "@/components/crm/CrmLayout";
import { LogUpdateForm, type LogUpdateResult } from "./LogUpdateForm";

/** "Log update" on a CRM record: the Leads drawer's form in a dialog. */
export function LogUpdateButton({ personId, onLogged }: { personId: string; onLogged: (result: LogUpdateResult) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Modal.Root open={open} onOpenChange={setOpen}>
      <Modal.Trigger asChild>
        <button type="button" className={subtleButtonClass} title="Log a call, message or meeting that happened outside AgentSDR">
          <RiStickyNoteAddLine className="size-4" aria-hidden="true" />
          Log update
        </button>
      </Modal.Trigger>
      <Modal.Content size="max-w-lg">
        <Modal.Header icon={RiStickyNoteAddLine}>
          <Modal.Title>Log an update</Modal.Title>
          <Modal.Description>Something that happened outside AgentSDR: a call from your phone, a WhatsApp from your own number, a meeting.</Modal.Description>
        </Modal.Header>
        <Modal.Body>
          {open && <LogUpdateForm personId={personId} framed={false} onCancel={() => setOpen(false)} onLogged={(result) => { setOpen(false); onLogged(result); }} />}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
