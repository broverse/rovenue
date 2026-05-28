import { useIntegrationDeliveries } from "../../../lib/hooks/useProjectIntegrations";
import { cn } from "../../../lib/cn";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StepDeliveriesProps {
  projectId: string;
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StepDeliveries({ projectId, connectionId }: StepDeliveriesProps) {
  const { data, isFetching, fetchNextPage, hasNextPage } =
    useIntegrationDeliveries(projectId, connectionId, {});

  const deliveries = data?.pages.flatMap((p) => p.deliveries) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {deliveries.length === 0 && !isFetching ? (
        <p className="text-[12px] text-rv-mute-500">No deliveries yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-rv-divider text-left">
                <th className="pb-2 pr-3 font-medium text-rv-mute-500">Event</th>
                <th className="pb-2 pr-3 font-medium text-rv-mute-500">Status</th>
                <th className="pb-2 pr-3 font-medium text-rv-mute-500">HTTP</th>
                <th className="pb-2 font-medium text-rv-mute-500">When</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr
                  key={d.id}
                  className="border-b border-rv-divider/50 last:border-0"
                >
                  <td className="py-2 pr-3 font-rv-mono text-[11px] text-rv-mute-800">
                    {d.eventKey}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={cn(
                        "inline-block rounded px-1.5 py-0.5 font-rv-mono text-[10px]",
                        d.status === "succeeded"
                          ? "bg-rv-success/14 text-rv-success"
                          : d.status === "dead_letter"
                          ? "bg-rv-danger/14 text-rv-danger"
                          : d.status === "failed"
                          ? "bg-rv-danger/14 text-rv-danger"
                          : d.status === "skipped"
                          ? "bg-rv-c3 text-rv-mute-500"
                          : "bg-rv-warning/14 text-rv-warning",
                      )}
                    >
                      {d.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-rv-mono text-[11px] text-rv-mute-600">
                    {d.httpStatus ?? "—"}
                  </td>
                  <td className="py-2 font-rv-mono text-[11px] text-rv-mute-500">
                    {new Date(d.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasNextPage && (
        <button
          type="button"
          onClick={() => void fetchNextPage()}
          disabled={isFetching}
          className={cn(
            "rounded-md border border-rv-divider bg-rv-c2 px-4 py-2 text-[12px] font-medium text-foreground transition hover:bg-rv-c3",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {isFetching ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
