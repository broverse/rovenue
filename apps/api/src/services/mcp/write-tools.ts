import { McpServer } from "@modelcontextprotocol/server";
import {
  acceptedContent,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { drizzle, MemberRole } from "@rovenue/db";
import { assertProjectAccess } from "../../lib/project-access";
import { executeIntent } from "../copilot/intent-executor";
import {
  buildExperimentStartPreview,
  buildExperimentStopPreview,
} from "../copilot/tools/action-experiments";
import {
  asMcpInputSchema,
  errPayload,
  okPayload,
  type McpToolContext,
} from "./tools";

/**
 * The two write tools (spec D5). They never mutate directly: the first
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

interface WriteSpec {
  /** Chat action tool backing this MCP tool (intent toolName). */
  actionTool: "action_experiments_start" | "action_experiments_stop";
  requiresRole: "ADMIN";
  buildPreview: (input: {
    experimentId: string;
    winnerVariantId?: string;
    reason: string;
  }) => unknown;
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
  spec: WriteSpec,
  experimentId: string,
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
  const payload = intent.payload as {
    experimentId?: unknown;
    winnerVariantId?: unknown;
    reason?: unknown;
  };
  // Bind the confirmation to the proposed experiment: the retry must echo
  // the same args, and execution uses the previewed payload, never the
  // retry's (possibly swapped) arguments.
  if (payload.experimentId !== experimentId) {
    return failed("confirmation does not match the proposed experiment");
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
  spec: WriteSpec,
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

function registerWriteTool(
  server: McpServer,
  ctx: McpToolContext,
  name: "start_experiment" | "stop_experiment",
  description: string,
  inputSchema: z.ZodTypeAny,
  annotations: { readOnlyHint: boolean; destructiveHint: boolean },
  spec: WriteSpec,
): void {
  server.registerTool(
    name,
    { description, inputSchema: asMcpInputSchema(inputSchema), annotations },
    async (rawArgs: unknown, sdkCtx?: McpRetryContext) => {
      const args = rawArgs as {
        experimentId: string;
        winnerVariantId?: string;
        reason: string;
      };
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
            payload: {
              experimentId: args.experimentId,
              ...(args.winnerVariantId !== undefined
                ? { winnerVariantId: args.winnerVariantId }
                : {}),
              reason: args.reason,
            },
            preview: spec.buildPreview({
              experimentId: args.experimentId,
              winnerVariantId: args.winnerVariantId,
              reason: args.reason,
            }),
            requiresRole: spec.requiresRole,
          },
        );
        return inputRequired({
          inputRequests: {
            [CONFIRM_KEY]: inputRequired.elicit({
              message:
                `Confirm ${name} on experiment ${args.experimentId} ` +
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
        await rejectIntentQuietly(requestState, ctx, spec);
        return errPayload(`${name} declined — nothing was changed.`);
      }
      const confirmed = acceptedContent(responses, CONFIRM_KEY, ConfirmSchema);
      if (!confirmed?.confirm) {
        await rejectIntentQuietly(requestState, ctx, spec);
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
          spec,
          args.experimentId,
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
 * Register the two write tools on a per-request server. Annotations
 * differ honestly (spec D4, verified against ToolAnnotationsSchema in the
 * installed SDK): stopping concludes enrollment and records a winner —
 * destructive; starting begins enrollment and is reversible via stop.
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
    },
  );
}
