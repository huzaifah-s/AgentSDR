import "server-only";

import { PermanentRunError } from "@/lib/grid/runners/types";
import { asRecord } from "../server/helpers";

const API_BASE = "https://api.companyenrich.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type CompanyEnrichPath = "/companies/enrich" | "/companies/search" | "/people/search" | "/me";

export function reportedCredits(body: unknown, headers: Headers): number | null {
  const fromBody = asRecord(body).creditsConsumed;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  const header = headers.get("x-credit-cost");
  if (header !== null && header.trim() !== "") {
    const cost = Number(header);
    if (Number.isFinite(cost) && cost >= 0) return cost;
  }
  return null;
}

function parseExactJson(text: string): unknown {
  // JSON strings are matched first so numbers embedded in profile text stay unchanged.
  const exact = text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
    /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token);
  return JSON.parse(exact);
}

async function readBody(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new PermanentRunError("CompanyEnrich response exceeded the 2 MiB limit. The request may have consumed credits.");
  }
  if (!response.body) throw new PermanentRunError("CompanyEnrich returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PermanentRunError("CompanyEnrich response exceeded the 2 MiB limit. The request may have consumed credits.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return parseExactJson(text);
  } finally {
    reader.releaseLock();
  }
}

export async function requestCompanyEnrich(
  path: CompanyEnrichPath,
  apiKey: string | undefined,
  options: { body?: Record<string, unknown>; query?: URLSearchParams; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ status: number; body: unknown; credits: number | null; latencyMs: number }> {
  const key = apiKey?.trim();
  if (!key || /^Bearer\s/i.test(key) || /[\r\n]/.test(key)) {
    throw new PermanentRunError("Enter the CompanyEnrich API key without the Bearer prefix.");
  }
  const timeout = Number.isFinite(options.timeoutMs) ? Math.min(30_000, Math.max(1, Math.floor(options.timeoutMs!))) : 30_000;
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const started = Date.now();
  try {
    signal.throwIfAborted();
    const response = await fetch(`${API_BASE}${path}${options.query ? `?${options.query}` : ""}`, {
      method: options.body ? "POST" : "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${key}`, ...(options.body ? { "Content-Type": "application/json" } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: "error", cache: "no-store", signal,
    });
    const credits = reportedCredits(null, response.headers);
    if (response.status === 404 && path === "/companies/enrich") {
      await response.body?.cancel();
      return { status: 404, body: null, credits: credits ?? 0, latencyMs: Date.now() - started };
    }
    if (!response.ok) {
      await response.body?.cancel();
      const detail = response.status === 401 ? "The API key was rejected."
        : response.status === 402 ? "The account has insufficient credits."
          : response.status === 403 ? "The account cannot access this operation."
            : response.status === 429 ? "The account is rate limited."
              : `The API returned HTTP ${response.status}.`;
      throw new PermanentRunError(`CompanyEnrich: ${detail} No automatic retry was made; check account usage before retrying.`, {
        provider: "companyenrich", request: { path }, response: { status: response.status, creditsConsumed: credits },
      });
    }
    if (path === "/me") {
      // /me may echo the API key; verification must never parse, return or audit its body.
      await response.body?.cancel();
      return { status: response.status, body: null, credits: 0, latencyMs: Date.now() - started };
    }
    const body = await readBody(response);
    return { status: response.status, body, credits: reportedCredits(body, response.headers), latencyMs: Date.now() - started };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    throw new PermanentRunError("CompanyEnrich request could not be completed. No automatic retry was made; the request may have consumed credits. Check account usage before retrying.");
  }
}
