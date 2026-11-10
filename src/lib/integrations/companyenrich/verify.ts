import "server-only";

import { requestCompanyEnrich } from "./transport";

export async function verifyCompanyEnrichCredentials(credentials: Record<string, string>): Promise<void> {
  await requestCompanyEnrich("/me", credentials.apiKey, { timeoutMs: 10_000 });
}
