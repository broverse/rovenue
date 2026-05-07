import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, FileDown } from "lucide-react";
import {
  AccountPageHeader,
  AccountShell,
  InvoiceStatusChip,
  SectionCard,
  type InvoiceStatus,
} from "../../../components/account";
import { Button } from "../../../ui/button";

export const Route = createFileRoute("/_authed/account/invoices")({
  component: InvoicesPage,
});

type InvoiceRow = {
  id: string;
  date: string;
  desc: string;
  status: InvoiceStatus;
  amount: number;
};

const INVOICES: ReadonlyArray<InvoiceRow> = [
  { id: "INV-2026-0421", date: "May 1, 2026", desc: "Scale plan · May 2026", status: "paid", amount: 499 },
  { id: "INV-2026-0392", date: "Apr 1, 2026", desc: "Scale plan · Apr 2026 + overage 2.1M events", status: "paid", amount: 562.4 },
  { id: "INV-2026-0361", date: "Mar 1, 2026", desc: "Scale plan · Mar 2026", status: "paid", amount: 499 },
  { id: "INV-2026-0328", date: "Feb 1, 2026", desc: "Scale plan · Feb 2026", status: "paid", amount: 499 },
  { id: "INV-2026-0294", date: "Jan 14, 2026", desc: "Pro → Scale plan upgrade · prorated", status: "paid", amount: 312.5 },
  { id: "INV-2026-0291", date: "Jan 1, 2026", desc: "Pro plan · Jan 2026", status: "refunded", amount: -149 },
  { id: "INV-2025-0257", date: "Dec 15, 2025", desc: "On-demand SQL credit top-up", status: "paid", amount: 50 },
  { id: "INV-2025-0224", date: "Dec 1, 2025", desc: "Pro plan · Dec 2025", status: "paid", amount: 149 },
];

function InvoicesPage() {
  const { t } = useTranslation();

  return (
    <AccountShell active="invoices">
      <AccountPageHeader
        title={t("account.invoices.title")}
        description={t("account.invoices.subtitle")}
      />

      <SectionCard
        title={t("account.invoices.history.title")}
        description={t("account.invoices.history.subtitle", { count: 24 })}
        right={
          <div className="flex flex-wrap gap-2">
            <Button variant="flat">
              <ArrowDownToLine size={13} />
              {t("account.invoices.exportCsv")}
            </Button>
            <Button variant="flat">
              <FileDown size={13} />
              {t("account.invoices.downloadAll")}
            </Button>
          </div>
        }
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[12px]">
            <thead>
              <tr>
                {[
                  { key: "invoice", w: 130 },
                  { key: "date", w: 100, hideMobile: true },
                  { key: "description" },
                  { key: "status", w: 110 },
                  { key: "amount", w: 100, num: true },
                  { w: 100 },
                ].map((c, i) => (
                  <th
                    key={i}
                    style={c.w ? { width: c.w } : undefined}
                    className={`border-b border-rv-divider bg-rv-c2 px-3 py-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500 ${c.num ? "text-right" : "text-left"} ${c.hideMobile ? "hidden sm:table-cell" : ""}`}
                  >
                    {c.key ? t(`account.invoices.cols.${c.key}`) : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {INVOICES.map((inv) => (
                <tr key={inv.id} className="hover:bg-rv-c2">
                  <td className="border-b border-white/[0.04] px-3 py-3 font-rv-mono text-[11px] text-rv-mute-700">
                    {inv.id}
                  </td>
                  <td className="hidden border-b border-white/[0.04] px-3 py-3 font-rv-mono text-[11px] text-rv-mute-500 sm:table-cell">
                    {inv.date}
                  </td>
                  <td className="border-b border-white/[0.04] px-3 py-3">{inv.desc}</td>
                  <td className="border-b border-white/[0.04] px-3 py-3">
                    <InvoiceStatusChip status={inv.status} />
                  </td>
                  <td className="border-b border-white/[0.04] px-3 py-3 text-right font-rv-mono">
                    {inv.amount < 0 ? "-" : ""}${Math.abs(inv.amount).toFixed(2)}
                  </td>
                  <td className="border-b border-white/[0.04] px-3 py-3 text-right">
                    <Button variant="light" className="h-6 px-2 text-[11px]">
                      {t("account.invoices.pdf")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </AccountShell>
  );
}
