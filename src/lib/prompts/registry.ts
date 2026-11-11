/**
 * Every prompt AgentSDR writes itself, by its Langfuse name. An
 * organization's Langfuse project holds its live versions (label
 * "production"); these copies are what saving the integration uploads
 * (src/lib/observability/langfusePrompts.ts) and what a call uses when the
 * organization has not connected Langfuse or it cannot be reached. Names are
 * "<area>/<what>", which Langfuse shows as folders.
 *
 * Only prompts written in code live here. What organizations write (CRM and
 * calling instructions, knowledge, campaign instructions) stays in the
 * database and reaches a prompt as a variable.
 *
 * Pure text and import-free beyond the domain lists, so client code may read it.
 */
import { CALLS_PROMPTS } from "./calls";
import { CRM_PROMPTS } from "./crm";
import { GRID_PROMPTS } from "./grid";
import { LINKEDIN_PROMPTS } from "./linkedin";
import { QUALIFICATION_PROMPTS } from "./qualification";
import { SHARED_PROMPTS } from "./shared";
import { TRANSCRIPTION_PROMPTS } from "./transcription";
import type { PromptDefinition } from "./types";

export const PROMPTS = {
  ...SHARED_PROMPTS,
  ...CRM_PROMPTS,
  ...GRID_PROMPTS,
  ...QUALIFICATION_PROMPTS,
  ...TRANSCRIPTION_PROMPTS,
  ...CALLS_PROMPTS,
  ...LINKEDIN_PROMPTS,
} satisfies Record<string, PromptDefinition>;

export type PromptName = keyof typeof PROMPTS;
