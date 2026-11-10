import type { GridColumn } from "@/lib/grid/schema";
import type { IntegrationOutputConfig } from "@/lib/grid/types";
import { APOLLO } from "./apollo/definition";
import { CLEANLIST } from "./cleanlist/definition";
import { COMPANYENRICH } from "./companyenrich/definition";
import { CONTACTOUT } from "./contactout/definition";
import { FINDYMAIL } from "./findymail/definition";
import { FULLENRICH } from "./fullenrich/definition";
import { HUNTER } from "./hunter/definition";
import { ICYPEAS } from "./icypeas/definition";
import { LEADMAGIC } from "./leadmagic/definition";
import { LUSHA } from "./lusha/definition";
import { MILLIONVERIFIER } from "./millionverifier/definition";
import { SNOV } from "./snov/definition";
import { SEMRUSH } from "./semrush/definition";
import { ROCKETREACH } from "./rocketreach/definition";
import { SIMILARWEB } from "./similarweb/definition";
import { ZEROBOUNCE } from "./zerobounce/definition";
import type {
  ActionCategory,
  InputValueType,
  IntegrationActionDefinition,
  IntegrationDefinition,
} from "./types";

export const ACTION_CATEGORIES: ReadonlyArray<{ key: ActionCategory; name: string }> = [
  { key: "ai", name: "AI" },
  { key: "enrich-company-info", name: "Enrich company info" },
  { key: "enrich-person-info", name: "Enrich person info" },
  { key: "extract", name: "Extract" },
  { key: "normalize", name: "Normalize" },
  { key: "score", name: "Score" },
  { key: "organize", name: "Organize" },
  { key: "summarize", name: "Summarize" },
  { key: "tools", name: "Tools" },
];

export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  APOLLO,
  CLEANLIST,
  COMPANYENRICH,
  SNOV,
  MILLIONVERIFIER,
  CONTACTOUT,
  FINDYMAIL,
  FULLENRICH,
  HUNTER,
  LEADMAGIC,
  LUSHA,
  ZEROBOUNCE,
  SIMILARWEB,
  SEMRUSH,
  ROCKETREACH,
  ICYPEAS,
];

export function getIntegration(key: string): IntegrationDefinition | null {
  return INTEGRATIONS.find((integration) => integration.key === key) ?? null;
}

export function getIntegrationAction(
  integrationKey: string,
  actionKey: string,
): IntegrationActionDefinition | null {
  return getIntegration(integrationKey)?.actions.find((action) => action.key === actionKey) ?? null;
}

export function compatibleColumns(
  input: IntegrationActionDefinition["inputs"][number],
  columns: Pick<GridColumn, "type" | "config">[],
) {
  return columns.filter((column) => {
    if (column.type !== "integration_output") {
      return input.acceptedColumnTypes.some((type) => type === column.type);
    }
    const config = column.config as IntegrationOutputConfig;
    const valueType = config.valueType ?? getIntegrationAction(config.integrationKey, config.actionKey)
      ?.outputs.find((output) => output.key === config.outputKey)?.columnType ?? "text";
    return input.acceptedColumnTypes.some((type) => type === valueType);
  });
}

/** Runtime guardrail for row values before any paid provider request is made. */
export function validateInputValue(
  type: InputValueType,
  value: unknown,
  multiple = false,
): string | null {
  if (value === null || value === undefined || value === "") return "A value is required";
  if (multiple && Array.isArray(value)) {
    if (!value.length) return "Expected at least one value";
    for (const item of value) {
      const issue = validateInputValue(type, item);
      if (issue) return `Invalid list value: ${issue}`;
    }
    return null;
  }
  if (multiple && typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return "Expected a JSON array";
      return validateInputValue(type, parsed, true);
    } catch {
      return "Expected a valid JSON array";
    }
  }
  if (type === "text") return typeof value === "string" ? null : "Expected text";
  if (type === "email") {
    return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      ? null
      : "Expected a valid email address";
  }
  if (type === "url") {
    if (typeof value !== "string") return "Expected a valid URL";
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? null : "Expected an HTTP URL";
    } catch {
      return "Expected a valid URL";
    }
  }
  if (type === "domain") {
    if (typeof value !== "string") return "Expected a company domain";
    try {
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      return url.hostname.includes(".") ? null : "Expected a company domain";
    } catch {
      return "Expected a company domain";
    }
  }
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? null : "Expected a number";
  if (type === "boolean") return typeof value === "boolean" ? null : "Expected true or false";
  if (type === "date") return !Number.isNaN(Date.parse(String(value))) ? null : "Expected a valid date";
  if (type === "json") {
    if (value !== null && typeof value === "object") return null;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return parsed !== null && typeof parsed === "object" ? null : "Expected a JSON object or array";
      } catch {
        return "Expected valid JSON";
      }
    }
    return "Expected JSON";
  }
  return null;
}
