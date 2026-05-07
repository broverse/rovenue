import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";

type PaymentMethodRowProps = {
  brand: string;
  brandStyle?: { background?: string };
  number: string;
  meta: string;
  isDefault?: boolean;
  actions?: ReactNode;
};

export function PaymentMethodRow({
  brand,
  brandStyle,
  number,
  meta,
  isDefault,
  actions,
}: PaymentMethodRowProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "mb-2 flex items-center gap-3 rounded-md border bg-rv-c2 px-3.5 py-3 last:mb-0",
        isDefault ? "border-rv-accent-500/40" : "border-rv-divider",
      )}
    >
      <div
        className="flex h-7 w-11 shrink-0 items-center justify-center rounded font-rv-mono text-[10px] font-semibold text-white"
        style={brandStyle}
      >
        {brand}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-rv-mono text-[13px]">{number}</div>
        <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">{meta}</div>
      </div>
      {isDefault ? (
        <span className="rounded bg-rv-accent-500/15 px-2 py-0.5 font-rv-mono text-[10px] text-rv-accent-400">
          {t("account.billing.payment.default")}
        </span>
      ) : null}
      {actions ?? <Button variant="light">{t("common.edit")}</Button>}
    </div>
  );
}
