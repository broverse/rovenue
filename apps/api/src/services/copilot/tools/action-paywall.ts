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
// PATCH /paywalls/:id and this tool both gate on `assertProjectCapability(
// projectId, user.id, "paywalls:write")`, whose `CAPABILITY_ROLES` set is
// `["OWNER", "ADMIN", "DEVELOPER"]` (`apps/api/src/lib/capabilities.ts`) —
// GROWTH excluded. `createIntentTool`'s `requiresCapability` below is
// authoritative at execute time (`intents.ts`'s POST /:id/execute checks
// it before falling back to the rank gate) — see the design spec, D3.
//
// `requiresRole: "ADMIN"` is kept as the fallback that never fires for
// this tool (the not-null `copilot_intents.requires_role` column still
// needs a value). It predates the capability gate: the intent-execute
// path used to be RANK-based (`assertProjectAccess` / `ROLE_RANK`), and
// `ROLE_RANK` gives GROWTH the SAME rank as DEVELOPER — so
// `requiresRole: "DEVELOPER"` would have silently admitted GROWTH too,
// which `paywalls:write` does not allow. A rank gate cannot express a set
// that skips a same-rank role, so "ADMIN" was the tightest rank that was
// a subset of the capability (`{OWNER, ADMIN}` ⊆ `{OWNER, ADMIN,
// DEVELOPER}`). Same precedent as the sibling `action_products_updatePrice`,
// which has not migrated to `requiresCapability` and still relies on this.

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
      requiresCapability: "paywalls:write",
      buildPreview: (i) => buildEditTreePreview(i.op),
    }),
  };
}
