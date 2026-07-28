import { z } from "zod";
import { paywallTreeOpSchema, type PaywallNode, type PaywallTreeOp } from "@rovenue/shared/paywall";
import type { RoviIntentPreview } from "@rovenue/shared";
import { createIntentTool } from "./_action-helper";
import type { ToolContext } from "./query-subscribers";

// =============================================================
// action_paywall_editTree (P8 AI-FAB, §6.15)
// =============================================================
//
// Proposes a SINGLE structural edit to a paywall's builder-config tree
// — the same `PaywallTreeOp` union the dashboard builder VM applies by
// hand, via the shared `applyTreeOp` (Task 2). Like every other
// action_* tool, this only creates a pending intent; the actual
// dry-run + persistence happens in the `action_paywall_editTree`
// intent handler (`intent-handlers.ts`) once the user approves.
//
// PATCH /paywalls/:id gates on `assertProjectCapability(projectId,
// user.id, "products:write")` (`apps/api/src/routes/dashboard/paywalls.ts`),
// whose `CAPABILITY_ROLES` set is `["OWNER", "ADMIN", "DEVELOPER"]`
// (`apps/api/src/lib/capabilities.ts`) — GROWTH excluded. But the
// intent-execute gate (`assertProjectAccess` in `lib/project-access.ts`)
// is RANK-based, not set-based, and `ROLE_RANK` gives GROWTH the SAME
// rank as DEVELOPER (both 2) — so `requiresRole: "DEVELOPER"` would
// silently admit GROWTH too, which products:write does not allow. A
// rank gate cannot express a set that skips a same-rank role, so
// `requiresRole: "ADMIN"` is the tightest rank that is a subset of
// `products:write` (`{OWNER, ADMIN}` ⊆ `{OWNER, ADMIN, DEVELOPER}`) —
// same precedent as the sibling `action_products_updatePrice`, which
// shares this exact capability and already uses "ADMIN" for the same
// reason.

function describeSubtree(subtree: PaywallNode): string {
  const n = subtree as PaywallNode & { rows?: unknown[] };
  if (Array.isArray(n.rows)) return `${n.type} (${n.rows.length} steps)`;
  if ("children" in n && Array.isArray(n.children)) return `${n.type} (${n.children.length} items)`;
  return n.type;
}

function titleFor(op: PaywallTreeOp): string {
  switch (op.kind) {
    case "insert":
      return `Add ${describeSubtree(op.subtree)}`;
    case "replace":
      return `Replace ${op.nodeId} with ${describeSubtree(op.subtree)}`;
    case "remove":
      return `Remove node ${op.nodeId}`;
    case "updateProps": {
      const n = Object.keys(op.patch).length;
      return `Update ${op.nodeId} (${n} field${n === 1 ? "" : "s"})`;
    }
    case "setLocalizations": {
      const n = Object.keys(op.entries).length;
      return `Update ${n} string${n === 1 ? "" : "s"} for locale ${op.locale}`;
    }
  }
}

function targetFor(op: PaywallTreeOp): string {
  switch (op.kind) {
    case "insert":
      return op.parentId;
    case "replace":
    case "remove":
    case "updateProps":
      return op.nodeId;
    case "setLocalizations":
      return op.locale;
  }
}

function positionFor(op: PaywallTreeOp): string | number {
  return op.kind === "insert" ? op.index : "-";
}

/** Coerces a `PaywallTreeOp` into the flat kind/target/position preview
 *  rows the dashboard's intent-approval card renders. Exported so tests
 *  can assert the coercion directly, without going through the
 *  DB-backed `createIntentTool` execute path. */
export function buildEditTreePreview(op: PaywallTreeOp): RoviIntentPreview {
  return {
    title: titleFor(op),
    fields: [
      { label: "Kind", after: op.kind },
      { label: "Target", after: targetFor(op) },
      { label: "Position", after: positionFor(op) },
    ],
  };
}

const EditTreeArgs = z.object({
  paywallId: z.string().min(1),
  op: paywallTreeOpSchema,
});

export function actionPaywallTools(ctx: ToolContext) {
  return {
    "action_paywall_editTree": createIntentTool({
      ctx,
      toolName: "action_paywall_editTree",
      description:
        "Propose a single structural edit to a paywall's builder-config tree — insert, replace, or remove a node, patch a node's props, or update localized strings for a locale. Returns a pending intent; the user must approve before it executes. Call query_paywall_tree first to get valid node ids.",
      inputSchema: EditTreeArgs,
      requiresRole: "ADMIN",
      buildPreview: (i) => buildEditTreePreview(i.op),
    }),
  };
}
