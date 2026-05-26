import { createFileRoute, useParams } from "@tanstack/react-router";
import { useBillingInvoices } from "../../../../../lib/hooks/useBillingInvoices";
import {
  InvoiceStatusChip,
  type InvoiceStatus,
} from "../../../../../components/billing";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/invoices",
)({
  component: InvoicesPage,
});

function InvoicesPage() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/settings/invoices",
  });
  const invoices = useBillingInvoices(projectId);

  if (invoices.isLoading) return <div className="p-6">Loading…</div>;
  const rows = invoices.data ?? [];

  return (
    <div className="flex flex-col gap-3 p-6">
      {rows.length === 0 && (
        <p className="text-sm text-rv-mute-500">No invoices yet.</p>
      )}
      {rows.map((inv) => {
        const refunded = parseFloat(inv.refundedAmount ?? "0") > 0;
        const chipStatus: InvoiceStatus = refunded
          ? "refunded"
          : invStatusChip(inv.status);
        return (
          <div
            key={inv.id}
            className="flex items-center justify-between rounded-md border border-rv-mute-200 p-3"
          >
            <div className="flex flex-col">
              <span className="font-medium">{inv.number}</span>
              <span className="text-xs text-rv-mute-500">
                {new Date(inv.periodStart).toLocaleDateString()} –{" "}
                {new Date(inv.periodEnd).toLocaleDateString()}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <InvoiceStatusChip status={chipStatus} />
              <span className="font-rv-mono text-sm">
                ${parseFloat(inv.amountDue).toFixed(2)}
              </span>
              {inv.pdfUrl && (
                <a
                  className="text-sm text-rv-primary underline"
                  href={inv.pdfUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  PDF
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function invStatusChip(s: string): InvoiceStatus {
  return s === "paid" ? "paid" : "open";
}
