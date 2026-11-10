import "server-only";

import { INTEGRATIONS } from "../catalog";
import { APOLLO_HANDLERS } from "../apollo/actions";
import { CLEANLIST_HANDLERS } from "../cleanlist/actions";
import { COMPANYENRICH_HANDLERS } from "../companyenrich/actions";
import { CONTACTOUT_HANDLERS } from "../contactout/actions";
import { FINDYMAIL_HANDLERS } from "../findymail/actions";
import { FULLENRICH_HANDLERS } from "../fullenrich/actions";
import { HUNTER_HANDLERS } from "../hunter/actions";
import { ICYPEAS_HANDLERS } from "../icypeas/actions";
import { LEADMAGIC_HANDLERS } from "../leadmagic/actions";
import { LUSHA_HANDLERS } from "../lusha/actions";
import { MILLIONVERIFIER_HANDLERS } from "../millionverifier/actions";
import { SNOV_HANDLERS } from "../snov/actions";
import { SEMRUSH_HANDLERS } from "../semrush/actions";
import { ROCKETREACH_HANDLERS } from "../rocketreach/actions";
import { SIMILARWEB_HANDLERS } from "../similarweb/actions";
import { ZEROBOUNCE_HANDLERS } from "../zerobounce/actions";
import type { IntegrationActionHandler, IntegrationActionHandlers } from "./types";

const HANDLERS: IntegrationActionHandlers = {
  ...APOLLO_HANDLERS,
  ...CLEANLIST_HANDLERS,
  ...COMPANYENRICH_HANDLERS,
  ...SNOV_HANDLERS,
  ...MILLIONVERIFIER_HANDLERS,
  ...CONTACTOUT_HANDLERS,
  ...FINDYMAIL_HANDLERS,
  ...FULLENRICH_HANDLERS,
  ...HUNTER_HANDLERS,
  ...LEADMAGIC_HANDLERS,
  ...LUSHA_HANDLERS,
  ...ZEROBOUNCE_HANDLERS,
  ...SIMILARWEB_HANDLERS,
  ...SEMRUSH_HANDLERS,
  ...ROCKETREACH_HANDLERS,
  ...ICYPEAS_HANDLERS,
};

for (const integration of INTEGRATIONS) {
  for (const action of integration.actions) {
    if (action.implemented && !HANDLERS[action.handlerKey]) {
      throw new Error(
        `Integration action ${integration.key}/${action.key} is marked implemented but has no server handler`,
      );
    }
  }
}

export function getIntegrationActionHandler(handlerKey: string): IntegrationActionHandler | null {
  return HANDLERS[handlerKey] ?? null;
}
