import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assertExactKeys,
  assertObject,
  CrmConfigurationValidationError,
  parseUuid,
  resolvePipelineId,
} from "./categories";
import {
  MAX_AI_INSTRUCTION_BLOCKS,
  MAX_AI_INSTRUCTION_CONTENT_LENGTH,
  MAX_AI_INSTRUCTION_TITLE_LENGTH,
  MAX_AI_INSTRUCTIONS_TOTAL_LENGTH,
  renderAiInstructions,
  type AiInstructionBlock,
} from "./ai/instructions";
import { crmSettings } from "./schema";
import { DEFAULT_CALLING_INSTRUCTIONS } from "@/lib/calls/callingInstructions";
import { DEFAULT_POST_INSTRUCTIONS } from "@/lib/linkedin/posts/postInstructions";

export type CrmAiInstructions = {
  pipelineId: string;
  draftInstructions: AiInstructionBlock[];
  classificationInstructions: AiInstructionBlock[];
  /** What the AI voice agent follows: the organization's own, or the defaults while it has none. */
  callingInstructions: AiInstructionBlock[];
  /** False while the calling instructions are the defaults. */
  callingInstructionsCustomized: boolean;
  /** The LinkedIn content brief: the organization's own, or the defaults while it has none. */
  postInstructions: AiInstructionBlock[];
  /** False while the brief is the defaults. */
  postInstructionsCustomized: boolean;
};

export type CrmAiInstructionsPatch = {
  pipelineId?: string;
  draftInstructions?: AiInstructionBlock[] | null;
  classificationInstructions?: AiInstructionBlock[] | null;
  /** null (or an empty list): back to the defaults. */
  callingInstructions?: AiInstructionBlock[] | null;
  /** null (or an empty list): back to the defaults. */
  postInstructions?: AiInstructionBlock[] | null;
};

const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;

function parseInstructionBlocks(value: unknown, label: string): AiInstructionBlock[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new CrmConfigurationValidationError(`${label} must be a list of instruction blocks or null`);
  }
  if (value.length > MAX_AI_INSTRUCTION_BLOCKS) {
    throw new CrmConfigurationValidationError(`${label} can hold at most ${MAX_AI_INSTRUCTION_BLOCKS} blocks`);
  }
  const ids = new Set<string>();
  const blocks = value.map((item, index): AiInstructionBlock => {
    const where = `${label}[${index}]`;
    assertObject(item);
    assertExactKeys(item, ["id", "title", "content"]);
    if (typeof item.id !== "string" || !BLOCK_ID.test(item.id)) {
      throw new CrmConfigurationValidationError(`${where}.id must be 1–64 letters, digits, - or _`);
    }
    if (ids.has(item.id)) throw new CrmConfigurationValidationError(`${where}.id is duplicated`);
    ids.add(item.id);
    if (typeof item.title !== "string" || typeof item.content !== "string") {
      throw new CrmConfigurationValidationError(`${where} needs a string title and content`);
    }
    const title = item.title.trim();
    const content = item.content.trim();
    if (title.length > MAX_AI_INSTRUCTION_TITLE_LENGTH) {
      throw new CrmConfigurationValidationError(
        `${where}.title must be at most ${MAX_AI_INSTRUCTION_TITLE_LENGTH} characters`,
      );
    }
    if (content.length > MAX_AI_INSTRUCTION_CONTENT_LENGTH) {
      throw new CrmConfigurationValidationError(
        `"${title || "Untitled"}" must be at most ${MAX_AI_INSTRUCTION_CONTENT_LENGTH} characters`,
      );
    }
    return { id: item.id, title, content };
  });
  // Checked on what the prompt will actually receive.
  if ((renderAiInstructions(blocks)?.length ?? 0) > MAX_AI_INSTRUCTIONS_TOTAL_LENGTH) {
    throw new CrmConfigurationValidationError(
      `${label} are too long in total — keep them under ${MAX_AI_INSTRUCTIONS_TOTAL_LENGTH} characters`,
    );
  }
  return blocks.length ? blocks : null;
}

/** Validates a PUT body; only the fields present are returned. Pure. */
export function parseAiInstructionsPatch(body: unknown): CrmAiInstructionsPatch {
  assertObject(body);
  assertExactKeys(body, ["pipelineId", "draftInstructions", "classificationInstructions", "callingInstructions", "postInstructions"]);
  const patch: CrmAiInstructionsPatch = {};
  if (body.pipelineId !== undefined) patch.pipelineId = parseUuid(body.pipelineId, "pipelineId");
  if (body.draftInstructions !== undefined) {
    patch.draftInstructions = parseInstructionBlocks(body.draftInstructions, "Drafting instructions");
  }
  if (body.classificationInstructions !== undefined) {
    patch.classificationInstructions = parseInstructionBlocks(body.classificationInstructions, "Classification instructions");
  }
  if (body.callingInstructions !== undefined) {
    patch.callingInstructions = parseInstructionBlocks(body.callingInstructions, "Calling instructions");
  }
  if (body.postInstructions !== undefined) {
    patch.postInstructions = parseInstructionBlocks(body.postInstructions, "LinkedIn post instructions");
  }
  return patch;
}

export async function getCrmAiInstructions(pipelineId?: string): Promise<CrmAiInstructions> {
  const resolved = await resolvePipelineId(pipelineId);
  const [row] = await db
    .select({
      draftInstructions: crmSettings.draftInstructions,
      classificationInstructions: crmSettings.classificationInstructions,
      callingInstructions: crmSettings.callingInstructions,
      postInstructions: crmSettings.postInstructions,
    })
    .from(crmSettings)
    .where(eq(crmSettings.pipelineId, resolved))
    .limit(1);
  const calling = row?.callingInstructions?.length ? row.callingInstructions : null;
  const posts = row?.postInstructions?.length ? row.postInstructions : null;
  return {
    pipelineId: resolved,
    draftInstructions: row?.draftInstructions ?? [],
    classificationInstructions: row?.classificationInstructions ?? [],
    callingInstructions: calling ?? DEFAULT_CALLING_INSTRUCTIONS,
    callingInstructionsCustomized: calling !== null,
    postInstructions: posts ?? DEFAULT_POST_INSTRUCTIONS,
    postInstructionsCustomized: posts !== null,
  };
}

export async function updateCrmAiInstructions(input: unknown): Promise<CrmAiInstructions> {
  const patch = parseAiInstructionsPatch(input);
  const resolved = await resolvePipelineId(patch.pipelineId);
  const changes: {
    draftInstructions?: AiInstructionBlock[] | null;
    classificationInstructions?: AiInstructionBlock[] | null;
    callingInstructions?: AiInstructionBlock[] | null;
    postInstructions?: AiInstructionBlock[] | null;
  } = {};
  if (patch.callingInstructions !== undefined) changes.callingInstructions = patch.callingInstructions;
  if (patch.postInstructions !== undefined) changes.postInstructions = patch.postInstructions;
  if (patch.draftInstructions !== undefined) changes.draftInstructions = patch.draftInstructions;
  if (patch.classificationInstructions !== undefined) {
    changes.classificationInstructions = patch.classificationInstructions;
  }
  if (Object.keys(changes).length > 0) {
    await db
      .insert(crmSettings)
      .values({ pipelineId: resolved, ...changes })
      .onConflictDoUpdate({
        target: crmSettings.pipelineId,
        set: { ...changes, updatedAt: new Date() },
      });
  }
  return getCrmAiInstructions(resolved);
}

/**
 * The calling instructions an AI agent call follows, from the organization's
 * default pipeline; null = the defaults. A failure reads as null: a call must
 * not fail over its instructions.
 */
export async function loadCallingInstructions(): Promise<AiInstructionBlock[] | null> {
  try {
    const resolved = await resolvePipelineId();
    const [row] = await db
      .select({ callingInstructions: crmSettings.callingInstructions })
      .from(crmSettings)
      .where(eq(crmSettings.pipelineId, resolved))
      .limit(1);
    return row?.callingInstructions?.length ? row.callingInstructions : null;
  } catch (error) {
    console.error("[calls] loading the calling instructions failed; using the defaults", error);
    return null;
  }
}

/**
 * The LinkedIn content brief a post draft follows, from the organization's
 * default pipeline; null = the defaults. A failure reads as null: a draft
 * must not fail over its brief.
 */
export async function loadPostInstructions(): Promise<AiInstructionBlock[] | null> {
  try {
    const resolved = await resolvePipelineId();
    const [row] = await db
      .select({ postInstructions: crmSettings.postInstructions })
      .from(crmSettings)
      .where(eq(crmSettings.pipelineId, resolved))
      .limit(1);
    return row?.postInstructions?.length ? row.postInstructions : null;
  } catch (error) {
    console.error("[linkedin/posts] loading the post instructions failed; using the defaults", error);
    return null;
  }
}
