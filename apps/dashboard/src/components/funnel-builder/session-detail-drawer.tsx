import { component, useService } from "impair";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { FunnelSessionsApi } from "../../lib/services/funnel-sessions-api";
import { FunnelSessionsViewModel } from "./vm/funnel-sessions.vm";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

export const SessionDetailDrawer = component(() => {
  const sessions = useService(FunnelSessionsViewModel);
  const draft = useService(FunnelDraftViewModel);
  const api = useService(FunnelSessionsApi);
  const id = sessions.openSessionId;

  const { data: session, isLoading } = useQuery({
    queryKey: ["funnel-session-detail", draft.projectId, draft.funnelId, id],
    enabled: Boolean(id),
    queryFn: () => api.detail(draft.projectId, draft.funnelId, id!),
  });

  if (!id) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={() => sessions.close()}
      />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-[420px] flex-col border-l border-rv-divider-strong bg-rv-c1 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
        <header className="flex items-center justify-between border-b border-rv-divider px-4 py-3">
          <div>
            <h3 className="m-0 text-[13px] font-semibold">Session detail</h3>
            <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">{id}</div>
          </div>
          <button
            type="button"
            onClick={() => sessions.close()}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-rv-mute-600 hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={14} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading && <div className="text-[12px] text-rv-mute-500">Loading…</div>}
          {session && (
            <>
              <div className="mb-3 rounded border border-rv-divider bg-rv-c2 px-3 py-2.5 font-rv-mono text-[11px] text-rv-mute-700">
                <div>state: <span className="text-foreground">{session.state}</span></div>
                <div>current_page: <span className="text-foreground">{session.currentPageId ?? "—"}</span></div>
                <div>started: <span className="text-foreground">{session.startedAt}</span></div>
              </div>
              <h4 className="m-0 mb-2 text-[12px] font-semibold text-foreground">
                Answers ({session.answers.length})
              </h4>
              {session.answers.length === 0 ? (
                <div className="text-[11px] text-rv-mute-500">No answers recorded yet.</div>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {session.answers.map((a, i) => (
                    <li
                      key={i}
                      className="rounded border border-rv-divider bg-rv-c2 px-2.5 py-2 font-rv-mono text-[11px] text-rv-mute-700"
                    >
                      <span className="text-rv-accent-500">@{a.questionId}</span>{" "}
                      <span className="text-rv-mute-500">on {a.pageId}</span>
                      <div className="mt-0.5 text-foreground">{JSON.stringify(a.answer)}</div>
                    </li>
                  ))}
                </ul>
              )}
              {session.purchase && (
                <>
                  <h4 className="m-0 mb-2 mt-4 text-[12px] font-semibold text-foreground">
                    Purchase
                  </h4>
                  <div className="rounded border border-rv-divider bg-rv-c2 px-3 py-2.5 font-rv-mono text-[11px] text-rv-mute-700">
                    <div>amount: {session.purchase.amountCents} {session.purchase.currency}</div>
                    <div>paid_at: {session.purchase.paidAt}</div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
});
