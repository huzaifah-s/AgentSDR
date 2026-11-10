import { describe, expect, test } from "bun:test";
import {
  enabled,
  isMigrationControlPaused,
  migrationMutationBlockReason,
} from "./controls.ts";

describe("People migration operational controls", () => {
  test("accepts only explicit truthy environment values", () => {
    expect(enabled("TRUE")).toBe(true);
    expect(enabled(" 1 ")).toBe(true);
    expect(enabled("false")).toBe(false);
    expect(enabled(undefined)).toBe(false);
  });

  test("master migration mode pauses every worker class", () => {
    const env = { PEOPLE_MIGRATION_MODE: "true" };
    for (const control of [
      "emailOutbound",
      "linkedinOutbound",
      "linkedinResolution",
      "linkedinSearch",
      "gridWorker",
    ]) {
      expect(isMigrationControlPaused(control, env)).toBe(true);
    }
  });

  test("narrow controls pause only their worker class", () => {
    const env = { PAUSE_LINKEDIN_OUTBOUND: "1" };
    expect(isMigrationControlPaused("linkedinOutbound", env)).toBe(true);
    expect(isMigrationControlPaused("linkedinResolution", env)).toBe(false);
    expect(isMigrationControlPaused("emailOutbound", env)).toBe(false);
  });

  test("migration mode blocks campaign mutations but preserves webhooks", () => {
    const env = { PEOPLE_MIGRATION_MODE: "on" };
    expect(migrationMutationBlockReason("/api/outreach/campaigns/abc", "PATCH", env)).toBeString();
    expect(migrationMutationBlockReason("/api/linkedin/messages/send", "POST", env)).toBeString();
    expect(migrationMutationBlockReason("/api/outreach/inbox/drafts/abc/approve", "POST", env)).toBeString();
    expect(migrationMutationBlockReason("/api/v1/campaigns/abc/leads", "POST", env)).toBeString();
    expect(migrationMutationBlockReason("/api/webhooks/message-received", "POST", env)).toBeNull();
    expect(migrationMutationBlockReason("/api/outreach/webhooks/gmail-watch", "POST", env)).toBeNull();
    expect(migrationMutationBlockReason("/api/outreach/unsubscribe", "POST", env)).toBeNull();
    expect(migrationMutationBlockReason("/api/linkedin/campaigns", "GET", env)).toBeNull();
  });

  test("mutation-only pause remains active during selective worker canaries", () => {
    const env = { PEOPLE_MIGRATION_MODE: "false", PAUSE_CAMPAIGN_MUTATIONS: "true" };
    expect(migrationMutationBlockReason("/api/linkedin/campaigns", "POST", env)).toBeString();
    expect(isMigrationControlPaused("linkedinOutbound", env)).toBe(false);
    expect(migrationMutationBlockReason("/api/webhooks/connection-accepted", "POST", env)).toBeNull();
  });
});
