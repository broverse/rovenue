import { describe, expect, it } from "vitest";
import { loadTools } from "./index";

// =============================================================
// Action tool → intent handler payload contract (unit)
// =============================================================
//
// Regression for the P1 where action tools emitted payload keys the
// executor handlers never read (productGroupId vs accessId, toAppUserId
// vs toSubscriberId, featureFlagId vs flagId, filters vs rules,
// winningVariantId vs winnerVariantId). The tool's validated input is
// stored verbatim as intent.payload and passed unchanged to the handler
// (see _action-helper.ts + intent-executor.ts), so the tool's top-level
// schema keys MUST match exactly the keys the handler in
// intent-handlers.ts destructures. This test pins that contract.
// =============================================================

// Expected top-level input keys per action tool, mirroring exactly what
// the corresponding handler in intent-handlers.ts reads from `payload`.
// `reason` is collected by every action tool for the audit trail.
const EXPECTED_KEYS: Record<string, string[]> = {
  action_subscriptions_cancel: ["id", "reason", "effectiveAt"],
  action_subscriptions_refund: ["purchaseId", "reason"],
  action_subscribers_grantAccess: [
    "subscriberId",
    "accessId",
    "expiresDate",
    "reason",
  ],
  action_subscribers_transfer: ["fromSubscriberId", "toSubscriberId", "reason"],
  action_products_updatePrice: ["productId", "price", "currency", "reason"],
  action_audiences_create: ["name", "description", "rules", "reason"],
  action_audiences_update: [
    "audienceId",
    "name",
    "description",
    "rules",
    "reason",
  ],
  action_featureFlags_toggle: ["flagId", "enabled", "reason"],
  action_featureFlags_updateRules: ["flagId", "rules", "reason"],
  action_experiments_start: ["experimentId", "reason"],
  action_experiments_stop: ["experimentId", "winnerVariantId", "reason"],
};

function schemaKeys(tool: unknown): string[] {
  // AI SDK preserves the zod schema passed as `inputSchema`. zod v3
  // ZodObject exposes its fields via `.shape`.
  const schema = (tool as { inputSchema?: { shape?: Record<string, unknown> } })
    .inputSchema;
  return Object.keys(schema?.shape ?? {});
}

describe("action tool → handler payload contract", () => {
  const tools = loadTools({
    projectId: "prj_1",
    userId: "u_1",
    role: "ADMIN",
    threadId: "th_1",
    messageId: "msg_1",
  });

  for (const [name, expected] of Object.entries(EXPECTED_KEYS)) {
    it(`${name} emits exactly the keys its handler reads`, () => {
      const tool = (tools as Record<string, unknown>)[name];
      expect(tool, `tool ${name} should be registered`).toBeDefined();
      expect(schemaKeys(tool).sort()).toEqual([...expected].sort());
    });
  }
});
