import { useState } from "react";
import { useRoviIntents } from "../../../lib/hooks/useRoviIntents";
import { useRovi } from "../../../lib/hooks/useRovi";

// Shape the backend emits when an `action.*` tool fires. The chat
// stream surfaces this as the tool part's `output`; we render it as
// an inline approval card and dispatch the user's decision through
// the intents endpoints.
type IntentPayload = {
  intentId: string;
  toolName: string;
  requiresRole: string;
  preview: {
    title: string;
    fields: Array<{
      label: string;
      before?: string | number | null;
      after: string | number | null;
    }>;
  };
  expiresAt: string;
};

/** The `action_paywall_editTree` intent handler's execute result (Task 5)
 *  — the handler is now the SOLE writer for the op: it already applied and
 *  persisted it server-side, and returns the resulting `draftRevision` so
 *  a caller can chain edits. There is no op here to apply client-side —
 *  see `dispatchPaywallPatch`'s doc comment in `RoviProvider`. */
type EditTreeResult = { paywallId: string; draftRevision: number };

const EDIT_TREE_TOOL_NAME = "action_paywall_editTree";

function isEditTreeResult(v: unknown): v is EditTreeResult {
  return (
    typeof v === "object" &&
    v !== null &&
    "paywallId" in v &&
    "draftRevision" in v &&
    typeof (v as { paywallId: unknown }).paywallId === "string" &&
    typeof (v as { draftRevision: unknown }).draftRevision === "number"
  );
}

export function ApprovalCard({ intent }: { intent: IntentPayload }) {
  const { execute, reject } = useRoviIntents();
  const { dispatchPaywallPatch } = useRovi();
  const [decision, setDecision] = useState<
    "none" | "approved" | "rejected" | "failed"
  >("none");
  const [error, setError] = useState<string | null>(null);
  // Only ever populated for `action_paywall_editTree` — the backend has
  // ALREADY persisted the edit by the time this lands (Task 5); this is
  // kept around so "Refresh builder" can retry the NOTIFICATION (never
  // the op itself — there is nothing left to apply) once a builder is
  // mounted to receive it. The copy says exactly that: the edit is saved
  // either way, and the only thing a mounted builder adds is showing it.
  // ("Re-apply" and "open the builder to apply this change" described the
  // pre-Task-5 dry-run handler, where the edit really was unlanded until
  // the client applied it.)
  const [pendingEdit, setPendingEdit] = useState<EditTreeResult | null>(null);
  const [notified, setNotified] = useState(false);

  async function approve() {
    setError(null);
    try {
      const result = await execute.mutateAsync(intent.intentId);
      setDecision("approved");
      if (intent.toolName === EDIT_TREE_TOOL_NAME && isEditTreeResult(result)) {
        setPendingEdit(result);
        // Scoped to THIS edit's own paywallId — never the currently-open
        // route/thread — so a builder mounted for a DIFFERENT paywall
        // (navigated to after this intent was proposed) refuses the
        // notification instead of refetching the wrong tree.
        setNotified(dispatchPaywallPatch(result.paywallId));
      }
    } catch (e) {
      setError((e as Error).message);
      setDecision("failed");
    }
  }

  function reapply() {
    if (!pendingEdit) return;
    setNotified(dispatchPaywallPatch(pendingEdit.paywallId));
  }

  async function cancel() {
    try {
      await reject.mutateAsync(intent.intentId);
      setDecision("rejected");
    } catch {
      // Reject is best-effort; surface the cancelled state regardless
      // so the card collapses to a terminal note.
      setDecision("rejected");
    }
  }

  return (
    <div className="rounded-md border border-rv-divider bg-rv-c2 p-3 text-xs">
      <p className="mb-2 text-[11px] uppercase tracking-wide text-rv-mute-500">
        {intent.toolName} · requires {intent.requiresRole}
      </p>
      <p className="mb-2 text-sm font-medium text-foreground">
        {intent.preview.title}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-rv-mute-700">
        {intent.preview.fields.map((f, i) => (
          <div key={i} className="contents">
            <dt className="text-rv-mute-500">{f.label}</dt>
            <dd>
              {f.before !== undefined && f.before !== null ? (
                <>
                  <span className="text-rv-mute-500 line-through">
                    {String(f.before)}
                  </span>
                  {" → "}
                </>
              ) : null}
              <span className="text-foreground">
                {f.after === null ? "—" : String(f.after)}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      {decision === "none" ? (
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="h-7 rounded-md border border-rv-divider px-2.5 text-rv-mute-700 transition hover:bg-rv-c4 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={approve}
            disabled={execute.isPending}
            className="h-7 rounded-md bg-rv-c4 px-2.5 text-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {execute.isPending ? "Running…" : "Approve & Run"}
          </button>
        </div>
      ) : decision === "approved" && pendingEdit && !notified ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="text-[11px] text-rv-mute-600">
            Saved to this paywall's draft. Open its builder to see the change.
          </p>
          <button
            type="button"
            onClick={reapply}
            className="h-7 shrink-0 rounded-md border border-rv-divider px-2.5 text-[11px] text-rv-mute-700 transition hover:bg-rv-c4 hover:text-foreground"
          >
            Refresh builder
          </button>
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-rv-mute-600">
          {decision === "approved" &&
            (pendingEdit
              ? "Saved to the draft; the builder has been refreshed."
              : "Approved and executed.")}
          {decision === "rejected" && "Cancelled."}
          {decision === "failed" && (error ?? "Execution failed.")}
        </p>
      )}
    </div>
  );
}
