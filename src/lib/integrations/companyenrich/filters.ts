import "server-only";

import { PermanentRunError } from "@/lib/grid/runners/types";
import { SEARCH_SCHEMAS, type SearchSchema } from "./schemas";

function invalid(path: string, detail: string): never {
  throw new PermanentRunError(`CompanyEnrich ${path}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth;
}

export function companyDomain(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024) invalid("domain", "provide a company domain or website.");
  try {
    const url = new URL(value.includes("://") ? value.trim() : `https://${value.trim()}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) throw new Error();
    const domain = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
    if (domain.length > 253 || !domain.includes(".") || !domain.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) throw new Error();
    return domain;
  } catch {
    return invalid("domain", "provide an HTTP website or domain without credentials or a port.");
  }
}

function stringList(value: unknown, key: string): string[] {
  let list: unknown = value;
  if (typeof value === "string") {
    if (value.trim().startsWith("[")) {
      try { list = JSON.parse(value); } catch { invalid(key, "provide a valid JSON array."); }
    } else list = value.split(/[,\n]/).map((part) => part.trim());
  }
  if (!Array.isArray(list) || !list.length || !list.every((item) => typeof item === "string" && item.trim())) {
    return invalid(key, "provide a non-empty list of text values.");
  }
  return list.map((item: string) => item.trim());
}

function validate(value: unknown, schema: SearchSchema, path: string, depth = 0): void {
  if (depth > 20) invalid(path, "nested filters are too deep.");
  if (schema.$ref) {
    const target = SEARCH_SCHEMAS[schema.$ref.split("/").pop()!];
    if (!target) invalid(path, "unsupported filter schema.");
    return validate(value, target, path, depth + 1);
  }
  if (value === null && (schema.nullable || schema.enum?.includes(null))) return;
  if (schema.enum) {
    if (!schema.enum.includes(value)) invalid(path, "use one of the documented values.");
    return;
  }
  if (schema.type === "object") {
    if (!isRecord(value)) invalid(path, "expected an object.");
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) invalid(path, `missing ${required}.`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) invalid(path, `unknown filter ${key}.`);
      validate(item, properties[key], `${path}.${key}`, depth + 1);
    }
    if (typeof value.min === "number" && typeof value.max === "number" && value.min > value.max) invalid(path, "minimum cannot exceed maximum.");
    if (typeof value.minPercent === "number" && typeof value.maxPercent === "number" && value.minPercent > value.maxPercent) invalid(path, "minimum cannot exceed maximum.");
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) invalid(path, "expected an array.");
    if (schema.minItems !== undefined && value.length < schema.minItems) invalid(path, "too few values.");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) invalid(path, "too many values.");
    if (path.endsWith(".domains") && value.length > (path.includes(".similar.") ? 10 : 2500)) invalid(path, "too many domains.");
    // The public similar-company schema leaves workforceSize.items empty;
    // its documented shape matches the company-search workforce filter.
    const itemSchema = path.endsWith(".similar.workforceSize") ? SEARCH_SCHEMAS.CompanyWorkforceSizeInput : schema.items;
    if (itemSchema) value.forEach((item, index) => validate(item, itemSchema, `${path}[${index}]`, depth + 1));
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") invalid(path, "expected text.");
    if (schema.minLength !== undefined && value.length < schema.minLength) invalid(path, `minimum length is ${schema.minLength}.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) invalid(path, `maximum length is ${schema.maxLength}.`);
    if (schema.format === "uuid" && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) invalid(path, "expected a UUID.");
    if (schema.format === "date-time" && !isDateTime(value)) invalid(path, "expected an ISO date and time with a timezone.");
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) invalid(path, "expected a finite number.");
    if (schema.type === "integer" && !Number.isSafeInteger(value)) invalid(path, "expected a safe integer.");
    if (schema.format === "int32" && (value < -2147483648 || value > 2147483647)) invalid(path, "outside the 32-bit integer range.");
    if (schema.minimum !== undefined && value < schema.minimum) invalid(path, `minimum is ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) invalid(path, `maximum is ${schema.maximum}.`);
    return;
  }
  invalid(path, "unsupported filter type.");
}

function hasFilter(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasFilter);
  if (isRecord(value)) return Object.entries(value).some(([key, item]) => !["page", "pageSize", "semanticWeight", "similarityWeight", "minScore", "categoryOperator", "keywordsOperator", "technologiesOperator"].includes(key) && hasFilter(item));
  return typeof value === "string" ? value.trim().length > 0 : typeof value === "number" || typeof value === "boolean";
}

export function buildSearchBody(people: boolean, inputs: Record<string, unknown>): Record<string, unknown> {
  let filters: unknown = inputs.filters ?? {};
  if (typeof filters === "string") {
    try { filters = JSON.parse(filters); } catch { invalid("filters", "provide valid JSON."); }
  }
  if (!isRecord(filters)) invalid("filters", "provide a JSON object.");
  const body = { ...filters };
  for (const key of people ? ["domains", "positionQuery"] : ["query", "semanticQuery"]) {
    if (inputs[key] !== undefined) body[key] = people ? stringList(inputs[key], key) : inputs[key];
  }
  if (Array.isArray(body.domains)) body.domains = body.domains.map(companyDomain);
  body.page = inputs.page ?? body.page ?? 1;
  body.pageSize = inputs.pageSize ?? body.pageSize ?? 10;
  validate(body, SEARCH_SCHEMAS[people ? "PersonSearchPageInput" : "CompanySearchPageInput"], "filters");
  const page = body.page as number;
  const size = body.pageSize as number;
  if (page < 1 || size < 1 || size > 100 || page * size > 10_000) invalid("pagination", "page must be positive, page size 1–100, and page × page size at most 10,000.");
  if (!hasFilter(body)) invalid("filters", "provide at least one non-empty search criterion.");
  for (const prefix of ["atCurrentCompany", "atCurrentPosition"]) {
    const after = body[`${prefix}After`];
    const before = body[`${prefix}Before`];
    if (typeof after === "string" && typeof before === "string" && Date.parse(after) > Date.parse(before)) invalid(prefix, "after cannot be later than before.");
  }
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 64 * 1024) invalid("filters", "request exceeds the 64 KiB limit.");
  return body;
}
