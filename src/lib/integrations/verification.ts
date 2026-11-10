import "server-only";

import { verifyApolloCredentials } from "./apollo/verify";
import { verifyCleanlistCredentials } from "./cleanlist/verify";
import { verifyCompanyEnrichCredentials } from "./companyenrich/verify";
import { verifyContactOutCredentials } from "./contactout/verify";
import { verifyFindymailCredentials } from "./findymail/verify";
import { verifyFullEnrichCredentials } from "./fullenrich/verify";
import { verifyHunterCredentials } from "./hunter/verify";
import { verifyIcypeasCredentials } from "./icypeas/verify";
import { verifyLeadMagicCredentials } from "./leadmagic/verify";
import { verifyLushaCredentials } from "./lusha/verify";
import { verifyMillionVerifierCredentials } from "./millionverifier/verify";
import { verifySnovCredentials } from "./snov/verify";
import { verifySemrushCredentials } from "./semrush/verify";
import { verifyRocketReachCredentials } from "./rocketreach/verify";
import { verifySimilarwebCredentials } from "./similarweb/verify";
import { verifyZeroBounceCredentials } from "./zerobounce/verify";

const VERIFIERS: Record<string, (credentials: Record<string, string>) => Promise<void>> = {
  apollo: verifyApolloCredentials,
  cleanlist: verifyCleanlistCredentials,
  companyenrich: verifyCompanyEnrichCredentials,
  snov: verifySnovCredentials,
  millionverifier: verifyMillionVerifierCredentials,
  contactout: verifyContactOutCredentials,
  findymail: verifyFindymailCredentials,
  fullenrich: verifyFullEnrichCredentials,
  hunter: verifyHunterCredentials,
  leadmagic: verifyLeadMagicCredentials,
  lusha: verifyLushaCredentials,
  zerobounce: verifyZeroBounceCredentials,
  similarweb: verifySimilarwebCredentials,
  semrush: verifySemrushCredentials,
  rocketreach: verifyRocketReachCredentials,
  icypeas: verifyIcypeasCredentials,
};

/** Dispatches credential checks to the provider-owned verifier. */
export async function verifyIntegrationCredentials(
  integrationKey: string,
  credentials: Record<string, string>,
): Promise<void> {
  const verify = VERIFIERS[integrationKey];
  if (!verify) throw new Error(`Credential verification is not available for ${integrationKey}`);
  await verify(credentials);
}
