"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useState } from "react";
import * as Button from "@/components/alignui/button";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import { Callout } from "./SettingsKit";
import { ListSkeleton } from "./SettingsSkeletons";
import {
  INSTRUCTION_SECTIONS,
  InstructionSection,
  type InstructionField,
} from "@/components/crm/CrmAiInstructions";
import { asObject, crmFetch, errorMessage } from "@/components/crm/crm-utils";
import type { AiInstructionBlock } from "@/lib/crm/ai/instructions";
import { DEFAULT_CALLING_INSTRUCTIONS } from "@/lib/calls/callingInstructions";
import { DEFAULT_POST_INSTRUCTIONS } from "@/lib/linkedin/posts/postInstructions";

type Saved = Record<InstructionField, AiInstructionBlock[]> & { callingInstructionsCustomized: boolean; postInstructionsCustomized: boolean };

function parseBlocks(value: unknown): AiInstructionBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, title, content } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof title !== "string" || typeof content !== "string") return [];
    return [{ id, title, content }];
  });
}

const FIELDS = Object.keys(INSTRUCTION_SECTIONS) as InstructionField[];

export default function InstructionsSettings() {
  const [pipelineId, setPipelineId] = useState("");
  const [saved, setSaved] = useState<Saved | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = asObject(await crmFetch("/settings/ai-instructions"));
      setPipelineId(String(data.pipelineId ?? ""));
      setSaved({
        draftInstructions: parseBlocks(data.draftInstructions),
        classificationInstructions: parseBlocks(data.classificationInstructions),
        callingInstructions: parseBlocks(data.callingInstructions),
        callingInstructionsCustomized: data.callingInstructionsCustomized === true,
        postInstructions: parseBlocks(data.postInstructions),
        postInstructionsCustomized: data.postInstructionsCustomized === true,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <ListSkeleton rows={4} />;
  if (error)
    return (
      <Callout
        tone="error"
        title="Could not load the instructions"
        action={<Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => void load()}>Try again</Button.Root>}
      >
        {error}
      </Callout>
    );
  if (!saved) return null;
  if (!pipelineId) return <Callout tone="warning" title="No CRM pipeline yet">Instructions belong to the default CRM pipeline, and none is configured yet.</Callout>;

  return (
    // Both panels stay mounted (forceMount + hidden when inactive) so unsaved
    // edits in one tab survive switching to the other.
    <SegmentedControl.Root defaultValue={FIELDS[0]}>
      <SegmentedControl.List className="w-full auto-cols-fr sm:w-fit sm:auto-cols-auto">
        {FIELDS.map((field) => (
          <SegmentedControl.Trigger key={field} value={field} className="gap-1.5 px-3">
            {INSTRUCTION_SECTIONS[field].title}
            <span className="tabular-nums text-text-soft-400">{saved[field].length}</span>
          </SegmentedControl.Trigger>
        ))}
      </SegmentedControl.List>
      {FIELDS.map((field) => (
        <SegmentedControl.Content
          key={field}
          value={field}
          forceMount
          className="mt-5 data-[state=inactive]:hidden"
        >
          <InstructionSection
            {...INSTRUCTION_SECTIONS[field]}
            field={field}
            saved={saved[field]}
            pipelineId={pipelineId}
            onSaved={(blocks) => setSaved((current) => (current ? { ...current, [field]: blocks } : current))}
            {...(field === "callingInstructions"
              ? { defaults: DEFAULT_CALLING_INSTRUCTIONS, customized: saved.callingInstructionsCustomized }
              : field === "postInstructions"
                ? { defaults: DEFAULT_POST_INSTRUCTIONS, customized: saved.postInstructionsCustomized }
                : {})}
          />
        </SegmentedControl.Content>
      ))}
    </SegmentedControl.Root>
  );
}
