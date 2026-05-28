import { useState } from "react";
import { useRoviIntents } from "../../../lib/hooks/useRoviIntents";

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

export function ApprovalCard({ intent }: { intent: IntentPayload }) {
  const { execute, reject } = useRoviIntents();
  const [decision, setDecision] = useState<
    "none" | "approved" | "rejected" | "failed"
  >("none");
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setError(null);
    try {
      await execute.mutateAsync(intent.intentId);
      setDecision("approved");
    } catch (e) {
      setError((e as Error).message);
      setDecision("failed");
    }
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
      ) : (
        <p className="mt-3 text-[11px] text-rv-mute-600">
          {decision === "approved" && "Approved and executed."}
          {decision === "rejected" && "Cancelled."}
          {decision === "failed" && (error ?? "Execution failed.")}
        </p>
      )}
    </div>
  );
}
