import { useState } from "react";
import {
  useIntegrationDeliveries,
  useRedeliverDelivery,
  type IntegrationDeliveryRow,
} from "../../../lib/hooks/useProjectIntegrations";
import { cn } from "../../../lib/cn";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StepDeliveriesProps {
  projectId: string;
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Delivery statuses eligible for a manual redeliver — a receiver that gave
 *  up (dead_letter) or hit a permanent failure (failed) is worth retrying by
 *  hand; pending/succeeded/skipped rows have nothing useful to redo. */
const REDELIVERABLE_STATUSES = new Set<IntegrationDeliveryRow["status"]>([
  "dead_letter",
  "failed",
]);

const STATUS_FILTER_OPTIONS: ReadonlyArray<{
  value: "" | IntegrationDeliveryRow["status"];
  label: string;
}> = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" },
  { value: "dead_letter", label: "Dead letter" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StepDeliveries({ projectId, connectionId }: StepDeliveriesProps) {
  const [statusFilter, setStatusFilter] = useState<"" | IntegrationDeliveryRow["status"]>("");

  const { data, isFetching, fetchNextPage, hasNextPage } = useIntegrationDeliveries(
    projectId,
    connectionId,
    statusFilter ? { status: statusFilter } : {},
  );
  const redeliver = useRedeliverDelivery(projectId, connectionId);
  const [redeliveringId, setRedeliveringId] = useState<string | null>(null);

  const deliveries = data?.pages.flatMap((p) => p.deliveries) ?? [];

  const handleRedeliver = async (deliveryId: string) => {
    setRedeliveringId(deliveryId);
    try {
      await redeliver.mutateAsync(deliveryId);
    } finally {
      setRedeliveringId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <label htmlFor="delivery-status-filter" className="text-[12px] text-rv-mute-500">
          Status
        </label>
        <select
          id="delivery-status-filter"
          aria-label="Status"
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as "" | IntegrationDeliveryRow["status"])
          }
          className="h-7 rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground"
        >
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

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
                <th className="pb-2 pr-3 font-medium text-rv-mute-500">When</th>
                <th className="pb-2 font-medium text-rv-mute-500" />
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
                  <td className="py-2 pr-3 font-rv-mono text-[11px] text-rv-mute-500">
                    {new Date(d.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 text-right">
                    {REDELIVERABLE_STATUSES.has(d.status) && (
                      <button
                        type="button"
                        onClick={() => void handleRedeliver(d.id)}
                        disabled={redeliveringId === d.id}
                        className={cn(
                          "rounded border border-rv-divider bg-rv-c2 px-2 py-1 text-[11px] font-medium text-foreground transition hover:bg-rv-c3",
                          "disabled:cursor-not-allowed disabled:opacity-50",
                        )}
                      >
                        {redeliveringId === d.id ? "Redelivering…" : "Redeliver"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {redeliver.isError && (
        <p className="text-[12px] text-rv-danger" role="alert">
          {redeliver.error instanceof Error
            ? redeliver.error.message
            : "Failed to redeliver"}
        </p>
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
