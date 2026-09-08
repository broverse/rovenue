import { McpServer } from "@modelcontextprotocol/server";
import {
  acceptedContent,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { drizzle, MemberRole } from "@rovenue/db";
import type { RoviIntentPreview } from "@rovenue/shared";
import { assertProjectAccess } from "../../lib/project-access";
import { executeIntent } from "../copilot/intent-executor";
import {
  buildExperimentStartPreview,
  buildExperimentStopPreview,
} from "../copilot/tools/action-experiments";
// Input validation is the routes' own create schemas (dashboard parity —
// never a weaker MCP-side re-declaration). Same deliberate, narrow
// services→routes exception as intent-handlers.ts.
import { createBodySchema as createProductBodySchema } from "../../routes/dashboard/products";
import { createBodySchema as createOfferingBodySchema } from "../../routes/dashboard/offerings";
import { createBodySchema as createAccessBodySchema } from "../../routes/dashboard/access";
import { createBodySchema as createPlacementBodySchema } from "../../routes/dashboard/placements";
import { createAudienceBodySchema } from "../../routes/dashboard/audiences";
import {
  asMcpInputSchema,
  errPayload,
  okPayload,
  type McpToolContext,
} from "./tools";

/**
 * The write tools (design D5). They never mutate directly: the first
 * call creates a copilot intent — preview, requiresRole, expiry, status
 * machine — exactly as the dashboard does, and returns input_required.
 * Only a retried call carrying an accepted `confirm` elicitation executes,
 * through the same `executeIntent` + audit path as the dashboard.
 *
 * No `confirm_intent` tool exists by design: an agent able to call both
 * propose and confirm would reduce the human gate to the client's own
 * approval dialog.
 *
 * URL-mode elicitation is deliberately unused: the dashboard has no
 * intent-confirmation page (approval lives in the rovi panel's
 * approval card), so a URL would point at a 404. The form-mode message
 * names the intent id so a human client can still render the review.
 */

const CONFIRM_KEY = "confirm";

const ConfirmSchema = z.object({ confirm: z.boolean() });

// The dashboard audiences route carries projectId in the body (it is
// not project-path-scoped); MCP tools are project-scoped via ctx, so
// the tool takes the route's schema minus projectId — same field
// validations, never a re-declaration.
const CreateAudienceMcpSchema = createAudienceBodySchema.omit({
  projectId: true,
});

const StartExperimentArgs = z.object({
  experimentId: z.string().min(1),
  reason: z.string().default(""),
});

const StopExperimentArgs = z.object({
  experimentId: z.string().min(1),
  winnerVariantId: z.string().min(1).optional(),
  reason: z.string().default(""),
});

/** The SDK context slice the retry flow reads. Structural and minimal:
 * handlers must not depend on more of the transport than this. */
interface McpRetryContext {
  mcpReq?: {
    inputResponses?: Record<string, unknown>;
    droppedInputResponseKeys?: string[];
    requestState?: () => unknown;
  };
}

interface WriteSpec<A extends Record<string, unknown>> {
  /** Intent toolName this MCP tool proposes (executed via executeIntent). */
  actionTool: string;
  // requiresRole, not requiresCapability: the chat action tools the
  // experiment pair mirrors set ADMIN only (no experiments:write), and
  // the dashboard execute route prefers requiresCapability when set —
  // storing one here would gate the SAME intent differently depending on
  // who proposed it. The catalog creates have no chat counterpart at
  // all, and stay ADMIN-gated here as the least-privilege agent tier
  // (the dashboard's products:write also admits DEVELOPER). Same for
  // the placement/audience creates below: create_audience's chat
  // counterpart admits DEVELOPER, but the MCP tool stays ADMIN-gated.
  requiresRole: "ADMIN";
  buildPreview: (args: A) => unknown;
  /** One-line human summary for the confirm elicitation message. */
  describe: (args: A) => string;
}

/**
 * Canonical form for intent-payload binding: sorted keys, undefined
 * dropped (matching the jsonb round-trip, which drops undefined too).
 * The confirmation must echo ALL of the proposed arguments; the stored
 * payload and the echo are compared in this form so key order or an
 * explicit undefined can never split them apart — while any changed
 * value still fails closed.
 */
export function canonicalizeIntentPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeIntentPayload);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalizeIntentPayload(v);
    }
    return out;
  }
  return value;
}

export function intentPayloadsEqual(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(canonicalizeIntentPayload(a)) ===
    JSON.stringify(canonicalizeIntentPayload(b))
  );
}

/** Preview builders for the catalog creates (no chat counterpart — MCP-local). */
export function buildProductCreatePreview(input: {
  identifier: string;
  type: string;
  displayName: string;
}): RoviIntentPreview {
  return {
    title: `Create product ${input.identifier}`,
    fields: [
      { label: "Identifier", after: input.identifier },
      { label: "Type", after: input.type },
      { label: "Display Name", after: input.displayName },
    ],
  };
}

export function buildOfferingCreatePreview(input: {
  identifier: string;
}): RoviIntentPreview {
  return {
    title: `Create offering ${input.identifier}`,
    fields: [{ label: "Identifier", after: input.identifier }],
  };
}

export function buildEntitlementCreatePreview(input: {
  identifier: string;
  displayName: string;
}): RoviIntentPreview {
  return {
    title: `Create entitlement ${input.identifier}`,
    fields: [
      { label: "Identifier", after: input.identifier },
      { label: "Display Name", after: input.displayName },
    ],
  };
}

export function buildPlacementCreatePreview(input: {
  identifier: string;
  name: string;
}): RoviIntentPreview {
  return {
    title: `Create placement ${input.identifier}`,
    fields: [
      { label: "Identifier", after: input.identifier },
      { label: "Name", after: input.name },
    ],
  };
}

export function buildAudienceCreatePreview(input: {
  name: string;
  description?: string;
}): RoviIntentPreview {
  return {
    title: `Create audience "${input.name}"`,
    fields: [
      { label: "Name", after: input.name },
      { label: "Description", after: input.description ?? "" },
    ],
  };
}

/**
 * Load the pending intent named by the echoed requestState and verify
 * every property the server owns. requestState round-trips through the
 * client (attacker-controlled by definition), so it is used ONLY as a
 * database lookup key: existence, project ownership, tool binding,
 * argument binding, pending status and expiry are all re-checked here
 * against server-side state. A forged id fails closed — either no row,
 * or a row from another project that never matches this caller's scope.
 */
async function loadPendingIntent(
  requestState: unknown,
  ctx: McpToolContext,
  spec: WriteSpec<Record<string, unknown>>,
  echoArgs: Record<string, unknown>,
) {
  const failed = (error: string) => ({ intent: null, error });
  if (typeof requestState !== "string" || requestState === "") {
    return failed("confirmation carries no intent reference; propose again");
  }
  const intent = await drizzle.copilotIntentRepo.getIntent(
    drizzle.db,
    requestState,
  );
  if (!intent || intent.projectId !== ctx.projectId) {
    return failed("intent not found in this project; propose again");
  }
  if (intent.toolName !== spec.actionTool) {
    return failed("intent is for a different action; propose again");
  }
  // Bind the confirmation to the proposed call: the retry must echo ALL
  // of the original arguments, and execution uses the previewed payload,
  // never the retry's (possibly swapped) arguments. Canonical comparison
  // so key order or dropped undefineds never split an honest echo.
  if (!intentPayloadsEqual(intent.payload, echoArgs)) {
    return failed("confirmation does not match the proposed call");
  }
  if (intent.status !== "pending") {
    return failed(`intent already ${intent.status}; propose again`);
  }
  if (intent.expiresAt < new Date()) {
    await drizzle.copilotIntentRepo.transitionIntent(drizzle.db, intent.id, {
      status: "expired",
    });
    return failed("intent expired; propose again");
  }
  return { intent, error: null as string | null };
}

/** Best-effort rejection for the decline path: never throws, never leaks. */
async function rejectIntentQuietly(
  requestState: unknown,
  ctx: McpToolContext,
  spec: WriteSpec<Record<string, unknown>>,
): Promise<void> {
  try {
    if (typeof requestState !== "string" || requestState === "") return;
    const intent = await drizzle.copilotIntentRepo.getIntent(
      drizzle.db,
      requestState,
    );
    if (
      !intent ||
      intent.projectId !== ctx.projectId ||
      intent.toolName !== spec.actionTool ||
      intent.status !== "pending"
    ) {
      return;
    }
    await drizzle.copilotIntentRepo.transitionIntent(drizzle.db, intent.id, {
      status: "rejected",
    });
  } catch {
    // Declining must be safe even when the intent row is already gone.
  }
}

function registerWriteTool<A extends Record<string, unknown>>(
  server: McpServer,
  ctx: McpToolContext,
  name: string,
  description: string,
  inputSchema: z.ZodTypeAny,
  annotations: { readOnlyHint: boolean; destructiveHint: boolean },
  spec: WriteSpec<A>,
): void {
  const genericSpec = spec as WriteSpec<Record<string, unknown>>;
  server.registerTool(
    name,
    { description, inputSchema: asMcpInputSchema(inputSchema), annotations },
    async (rawArgs: unknown, sdkCtx?: McpRetryContext) => {
      const args = rawArgs as A;
      const echoArgs = args as Record<string, unknown>;
      const responses = sdkCtx?.mcpReq?.inputResponses;
      const requestState = sdkCtx?.mcpReq?.requestState?.();
      const dropped = sdkCtx?.mcpReq?.droppedInputResponseKeys ?? [];
      const view = responses
        ? inputResponse(responses, CONFIRM_KEY)
        : { kind: "missing" as const };

      // First call: propose. Create the intent exactly as the dashboard
      // does (thread/message are inert here, same precedent as tools),
      // then ask for confirmation in-band. Nothing has mutated.
      //
      // A "missing" view together with an echoed requestState (or dropped
      // response keys) is a malformed retry, not a first call: proposing
      // again would silently stack a duplicate intent, so refuse loudly.
      if (view.kind === "missing") {
        if (requestState !== undefined || dropped.length > 0) {
          return errPayload(
            `${name} confirmation not understood — re-issue the call with ` +
              `the ${CONFIRM_KEY} response and echoed request state, or propose again.`,
          );
        }
        const intent = await drizzle.copilotIntentRepo.createIntent(
          drizzle.db,
          {
            projectId: ctx.projectId,
            userId: ctx.userId,
            threadId: "",
            messageId: "",
            toolName: spec.actionTool,
            // The canonical echo shape, not the raw retry args: execution
            // binds to THIS payload, never to what the retry carries.
            payload: canonicalizeIntentPayload(
              echoArgs,
            ) as Record<string, unknown>,
            preview: spec.buildPreview(args),
            requiresRole: spec.requiresRole,
          },
        );
        return inputRequired({
          inputRequests: {
            [CONFIRM_KEY]: inputRequired.elicit({
              message:
                `Confirm ${name} ${spec.describe(args)} ` +
                `(intent ${intent.id}). Answer confirm=true to execute, ` +
                `or decline — nothing has changed yet.`,
              // The wire shape, not the zod schema: elicit() converts a
              // Standard Schema itself and rejects shapes it cannot
              // express. Validation of the answer still uses
              // ConfirmSchema below.
              requestedSchema: {
                type: "object",
                properties: { confirm: { type: "boolean" } },
                required: ["confirm"],
              },
            }),
          },
          requestState: intent.id,
        });
      }

      // Decline or cancel: record the rejection, change nothing. A tool
      // error (not a protocol error) so the model reads the outcome.
      if (view.kind !== "elicit" || view.action !== "accept") {
        await rejectIntentQuietly(requestState, ctx, genericSpec);
        return errPayload(`${name} declined — nothing was changed.`);
      }
      const confirmed = acceptedContent(responses, CONFIRM_KEY, ConfirmSchema);
      if (!confirmed?.confirm) {
        await rejectIntentQuietly(requestState, ctx, genericSpec);
        return errPayload(`${name} not confirmed — nothing was changed.`);
      }

      // Accepted: verify everything server-side, then execute through the
      // dashboard's own path (capability re-check at execute time, audit
      // inside the mutation transaction). Any failure is a tool result
      // the model can act on, never a protocol error.
      try {
        const loaded = await loadPendingIntent(
          requestState,
          ctx,
          genericSpec,
          echoArgs,
        );
        if (!loaded.intent) return errPayload(loaded.error ?? "unknown error");
        const { intent } = loaded;

        const membership = await assertProjectAccess(
          ctx.projectId,
          ctx.userId,
          intent.requiresRole as MemberRole,
        );
        // Execution failure marks the intent failed (dashboard parity):
        // a pending intent after a throw would let a later retry execute
        // a mutation whose first attempt partially ran.
        let result: unknown;
        try {
          result = await executeIntent({
            intent: {
              id: intent.id,
              toolName: intent.toolName,
              payload: intent.payload,
            },
            ctx: {
              projectId: ctx.projectId,
              userId: ctx.userId,
              role: membership.role,
            },
          });
        } catch (execErr) {
          await drizzle.copilotIntentRepo.transitionIntent(
            drizzle.db,
            intent.id,
            {
              status: "failed",
              error: {
                message:
                  execErr instanceof Error ? execErr.message : String(execErr),
              },
            },
          );
          throw execErr;
        }
        await drizzle.copilotIntentRepo.transitionIntent(
          drizzle.db,
          intent.id,
          { status: "executed", executedAt: new Date(), result },
        );
        return okPayload({
          intentId: intent.id,
          status: "executed",
          result,
        });
      } catch (err) {
        return errPayload(
          `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

/**
 * Register the write tools on a per-request server. Annotations
 * differ honestly (design D4; field names verified against the protocol's
 * ToolAnnotationsSchema in the installed SDK): stopping concludes
 * enrollment and records a winner — destructive; starting begins
 * enrollment and is reversible via stop. Creates only add rows and are
 * reversible via the dashboard delete paths — non-destructive.
 */
export function registerMcpWriteTools(
  server: McpServer,
  ctx: McpToolContext,
): void {
  registerWriteTool(
    server,
    ctx,
    "start_experiment",
    "Start a draft experiment to begin enrolling subscribers. Proposes a pending intent first — nothing changes until you confirm the elicitation.",
    StartExperimentArgs,
    { readOnlyHint: false, destructiveHint: false },
    {
      actionTool: "action_experiments_start",
      requiresRole: "ADMIN",
      buildPreview: buildExperimentStartPreview,
      describe: (args: z.infer<typeof StartExperimentArgs>) =>
        `on experiment ${args.experimentId}`,
    },
  );
  registerWriteTool(
    server,
    ctx,
    "stop_experiment",
    "Stop a running experiment and conclude enrollment. Proposes a pending intent first — nothing changes until you confirm the elicitation.",
    StopExperimentArgs,
    { readOnlyHint: false, destructiveHint: true },
    {
      actionTool: "action_experiments_stop",
      requiresRole: "ADMIN",
      buildPreview: buildExperimentStopPreview,
      describe: (args: z.infer<typeof StopExperimentArgs>) =>
        `on experiment ${args.experimentId}`,
    },
  );
  registerWriteTool(
    server,
    ctx,
    "create_product",
    "Create a product in the current project (identifier, type, display name, optional store ids, access ids, currency grants). Proposes a pending intent first — nothing changes until you confirm the elicitation.",
    createProductBodySchema,
    { readOnlyHint: false, destructiveHint: false },
    {
      actionTool: "action_products_create",
      requiresRole: "ADMIN",
      buildPreview: buildProductCreatePreview,
      describe: (args: z.infer<typeof createProductBodySchema>) =>
        `for product "${args.identifier}"`,
    },
  );
  registerWriteTool(
    server,
    ctx,
    "create_offering",
    "Create an offering in the current project (identifier, optional default flag, packages binding product ids). Proposes a pending intent first — nothing changes until you confirm the elicitation.",
    createOfferingBodySchema,
    { readOnlyHint: false, destructiveHint: false },
    {
      actionTool: "action_offerings_create",
      requiresRole: "ADMIN",
      buildPreview: buildOfferingCreatePreview,
      describe: (args: z.infer<typeof createOfferingBodySchema>) =>
        `for offering "${args.identifier}"`,
    },
  );
  registerWriteTool(
    server,
    ctx,
    "create_entitlement",
    "Create an entitlement (access-catalog row) in the current project (identifier, display name, optional description). Proposes a pending intent first — nothing changes until you confirm the elicitation.",
    createAccessBodySchema,
    { readOnlyHint: false, destructiveHint: false },
    {
      actionTool: "action_entitlements_create",
      requiresRole: "ADMIN",
      buildPreview: buildEntitlementCreatePreview,
      describe: (args: z.infer<typeof createAccessBodySchema>) =>
        `for entitlement "${args.identifier}"`,
    },
  );
  registerWriteTool(
    server,
    ctx,
    "create_placement",
    "Create a placement in the current project (identifier, name, optional rows, optional active flag). Proposes a pending intent first — nothing changes until you confirm the elicitation.",
    createPlacementBodySchema,
    { readOnlyHint: false, destructiveHint: false },
    {
      actionTool: "action_placements_create",
      requiresRole: "ADMIN",
      buildPreview: buildPlacementCreatePreview,
      describe: (args: z.infer<typeof createPlacementBodySchema>) =>
        `for placement "${args.identifier}"`,
    },
  );
  registerWriteTool(
    server,
    ctx,
    "create_audience",
    "Create an audience in the current project (name, optional description, rules). Proposes a pending intent first — nothing changes until you confirm the elicitation.",
    CreateAudienceMcpSchema,
    { readOnlyHint: false, destructiveHint: false },
    {
      actionTool: "action_audiences_create",
      requiresRole: "ADMIN",
      buildPreview: buildAudienceCreatePreview,
      describe: (args: z.infer<typeof CreateAudienceMcpSchema>) =>
        `for audience "${args.name}"`,
    },
  );
}
