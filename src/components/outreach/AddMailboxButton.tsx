"use client";

import { useState } from "react";
import { RiAddLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import ConnectMailboxDialog from "./ConnectMailboxDialog";

export default function AddMailboxButton({ googleConnected }: { googleConnected: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button.Root variant="primary" mode="filled" size="small" onClick={() => setOpen(true)}>
        <Button.Icon as={RiAddLine} />
        Add mailbox
      </Button.Root>
      {open && <ConnectMailboxDialog googleConnected={googleConnected} onClose={() => setOpen(false)} />}
    </>
  );
}
