import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";

export type InvoiceStatus = "paid" | "open" | "refunded";

const TONE: Record<InvoiceStatus, string> = {
  paid: "bg-rv-success/15 text-rv-success [&_.dot]:bg-rv-success",
  open: "bg-rv-warning/15 text-rv-warning [&_.dot]:bg-rv-warning",
  refunded: "bg-rv-c3 text-rv-mute-500 [&_.dot]:bg-rv-mute-500",
};

export function InvoiceStatusChip({ status }: { status: InvoiceStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-rv-mono text-[10px]",
        TONE[status],
      )}
    >
      <span className="dot inline-block size-[5px] rounded-full" />
      {t(`account.invoices.status.${status}`)}
    </span>
  );
}
