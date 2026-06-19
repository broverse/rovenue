import { BookOpen, MoreHorizontal, RotateCw, Webhook } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { formatAbsMoney, formatExactMoney } from "./format";
import { RefundConfirmDialog } from "./refund-confirm-dialog";
import { TransactionActionsMenu } from "./transaction-actions-menu";
import { TxIcon } from "./tx-icon";
import { TxStatusChip } from "./tx-status-chip";
import type { Transaction } from "./types";

type Props = {
  tx: Transaction;
  projectId: string;
};

const escapeHtml = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");

const tokenRegex =
  /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

const TOKEN_CLASSES = {
  key: "text-sky-300",
  str: "text-emerald-300",
  num: "text-amber-300",
  bool: "text-pink-300",
  null: "text-rv-mute-500",
} as const;

/** Same hand-rolled JSON highlighter the live-events panel uses. */
function highlightJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "null";
  return escapeHtml(json).replace(tokenRegex, (match) => {
    let cls: keyof typeof TOKEN_CLASSES = "num";
    if (match.startsWith('"')) cls = match.endsWith(":") ? "key" : "str";
    else if (match === "true" || match === "false") cls = "bool";
    else if (match === "null") cls = "null";
    return `<span class="${TOKEN_CLASSES[cls]}">${match}</span>`;
  });
}

/**
 * Right-side detail panel — shows the selected transaction's hero amount,
 * receipt math, references, and the raw webhook payload, all sticky to
 * the top of the viewport while the table scrolls underneath.
 */
export function TransactionInspector({ tx, projectId }: Props) {
  const { t } = useTranslation();
  const [refundOpen, setRefundOpen] = useState(false);
  const payload = {
    id: tx.id,
    type: tx.type,
    subscription_id: tx.sub,
    subscriber_id: tx.user,
    product_id: tx.product,
    store: tx.store,
    amount: { gross: tx.gross, fee: tx.fee, tax: tx.tax, net: tx.net },
    currency: tx.currency,
    country: tx.country,
    status: tx.status,
    is_renewal: tx.type === "renewal",
    is_refund: tx.type === "refund" || tx.type === "chargeback",
    created_at: "2026-04-20T14:48:12Z",
    ingested_at: "2026-04-20T14:48:12.217Z",
  };

  const heroTone =
    tx.net < 0 ? "text-rv-danger" : tx.net === 0 ? "text-rv-mute-500" : "text-foreground";

  return (
    <aside className="sticky top-[76px] flex max-h-[calc(100vh-96px)] flex-col overflow-y-auto rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-center gap-2.5 border-b border-rv-divider px-4 py-3.5">
        <TxIcon type={tx.type} size="md" />
        <div className="min-w-0 flex-1">
          <h4 className="truncate font-rv-mono text-[13px] font-semibold">{tx.id}</h4>
          <div className="font-rv-mono text-[11px] capitalize text-rv-mute-500">
            {t(`transactions.type.${tx.type}`)} · {tx.at}
          </div>
        </div>
        <Button variant="light" size="icon" aria-label={t("transactions.inspector.copyId")}>
          <BookOpen size={12} />
        </Button>
        <Button variant="light" size="icon" aria-label={t("transactions.inspector.more")}>
          <MoreHorizontal size={14} />
        </Button>
      </header>

      <div className="border-b border-rv-divider px-5 py-5 text-center">
        <div className={cn("font-rv-mono text-[32px] font-medium tabular-nums", heroTone)}>
          {formatExactMoney(tx.net)}
        </div>
        <div className="mt-1 font-rv-mono text-[11px] text-rv-mute-500">
          {t("transactions.inspector.amountSubtitle", { currency: tx.currency })}
        </div>
        <div className="mt-2.5 flex justify-center gap-4 font-rv-mono text-[11px] text-rv-mute-600">
          <span>
            {t("transactions.inspector.breakdown.gross")}{" "}
            <span className="text-foreground">{formatAbsMoney(tx.gross)}</span>
          </span>
          <span>
            {t("transactions.inspector.breakdown.fee")}{" "}
            <span className="text-foreground">{formatAbsMoney(tx.fee)}</span>
          </span>
          <span>
            {t("transactions.inspector.breakdown.tax")}{" "}
            <span className="text-foreground">{formatAbsMoney(tx.tax)}</span>
          </span>
        </div>
        <div className="mt-2.5">
          <TxStatusChip status={tx.status} />
        </div>
      </div>

      <Section heading={t("transactions.inspector.receipt")}>
        <ReceiptLine label={tx.product} value={`$${tx.gross.toFixed(2)}`} />
        <ReceiptLine
          label={t("transactions.inspector.receiptStoreFee", { store: tx.store })}
          value={`$${tx.fee.toFixed(2)}`}
          negative
        />
        <ReceiptLine
          label={t("transactions.inspector.receiptTax", { country: tx.country })}
          value={`$${tx.tax.toFixed(2)}`}
          negative
        />
        <ReceiptLine
          label={t("transactions.inspector.receiptNet")}
          value={`$${tx.net.toFixed(2)}`}
          total
        />
      </Section>

      <Section heading={t("transactions.inspector.references")}>
        <Kv k={t("transactions.inspector.ref.subscription")} v={tx.sub} />
        <Kv k={t("transactions.inspector.ref.subscriber")} v={tx.user} />
        <Kv k={t("transactions.inspector.ref.product")} v={tx.product} />
        <Kv k={t("transactions.inspector.ref.store")} v={tx.store} />
        <Kv k={t("transactions.inspector.ref.country")} v={tx.country} />
        <Kv k={t("transactions.inspector.ref.method")} v={tx.method} title={tx.method} />
      </Section>

      <Section heading={t("transactions.inspector.payload")}>
        <pre
          className="overflow-x-auto whitespace-pre rounded-md border border-rv-divider bg-rv-bg p-3 font-rv-mono text-[11px] leading-relaxed text-rv-mute-700"
          dangerouslySetInnerHTML={{ __html: highlightJson(payload) }}
        />
      </Section>

      <div className="flex gap-1.5 px-3 py-3">
        {tx.store !== "ios" && (
          <Button variant="flat" size="sm" className="flex-1" onClick={() => setRefundOpen(true)}>
            <RotateCw size={13} />
            {t("transactions.inspector.footer.refund")}
          </Button>
        )}
        <Button variant="flat" size="sm" className="flex-1">
          <Webhook size={13} />
          {t("transactions.inspector.footer.redeliver")}
        </Button>
        <TransactionActionsMenu projectId={projectId} tx={tx} payload={payload} />
      </div>
      <RefundConfirmDialog projectId={projectId} tx={tx} open={refundOpen} onClose={() => setRefundOpen(false)} />
    </aside>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-rv-divider px-4 py-3.5 last:border-b-0">
      <h5 className="mb-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {heading}
      </h5>
      {children}
    </section>
  );
}

function ReceiptLine({
  label,
  value,
  negative,
  total,
}: {
  label: string;
  value: string;
  negative?: boolean;
  total?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_auto] py-1 font-rv-mono text-[11px]",
        total && "mt-1.5 border-t border-rv-divider pt-2 text-[12px] font-medium",
      )}
    >
      <span className="text-rv-mute-600">{label}</span>
      <span className={cn(negative && "text-rv-danger")}>{value}</span>
    </div>
  );
}

function Kv({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div className="flex justify-between border-b border-white/[0.04] py-1.5 text-[12px] last:border-b-0">
      <span className="text-rv-mute-500">{k}</span>
      <span
        title={title}
        className="max-w-[230px] truncate font-rv-mono text-[11px] text-foreground"
      >
        {v}
      </span>
    </div>
  );
}
