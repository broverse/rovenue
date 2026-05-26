import { useTranslation } from "react-i18next";
import { StoreAvatar } from "./store-badge";
import type { TxStore } from "./types";

const STORE_NAME_KEY: Record<TxStore, string> = {
  ios: "transactions.stores.appStore",
  play: "transactions.stores.play",
  stripe: "transactions.stores.stripe",
  web: "transactions.stores.web",
  manual: "transactions.stores.manual",
};

export type StoreBreakdownRow = {
  store: TxStore;
  /** Pre-formatted revenue string. */
  revenue: string;
  /** Pre-formatted fee total; `null` for self-billed (web) stores. */
  fee: string | null;
  /** Pre-formatted fee percentage; `null` for self-billed stores. */
  feePercent: string | null;
  /** Pre-formatted share string with the % suffix. */
  share: string;
};

type StoreBreakdownProps = {
  rows?: ReadonlyArray<StoreBreakdownRow>;
};

/**
 * Per-store revenue strip that lives below the volume graph in the
 * Revenue Flow card. Renders a 4-column row at desktop widths, collapsing
 * to two columns under 1180px. Renders an empty / "awaiting data" state
 * when no rows are available rather than falling back to fixtures.
 */
export function StoreBreakdown({ rows }: StoreBreakdownProps = {}) {
  const { t } = useTranslation();

  if (!rows || rows.length === 0) {
    return (
      <div className="mt-4 flex items-center justify-center rounded-md border border-dashed border-rv-divider bg-rv-c2 px-4 py-6 text-[12px] text-rv-mute-500">
        {t("transactions.flow.awaitingStores")}
      </div>
    );
  }

  return (
    <div className="mt-4 grid grid-cols-2 gap-3 border-t border-rv-divider pt-4 max-[1180px]:grid-cols-2 lg:grid-cols-4">
      {rows.map((row) => {
        const feeLine =
          row.fee && row.feePercent
            ? t("transactions.stores.feeShort", { value: row.fee, percent: row.feePercent })
            : t("transactions.stores.selfBilled");
        return (
          <div key={row.store} className="flex min-w-0 items-center gap-2.5">
            <StoreAvatar store={row.store} size="md" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-foreground">
                {t(STORE_NAME_KEY[row.store])}
              </div>
              <div className="mt-0.5 font-rv-mono text-[14px] text-foreground tabular-nums">
                {row.revenue}
              </div>
              <div className="mt-0.5 truncate font-rv-mono text-[10px] text-rv-mute-500">
                {feeLine}
              </div>
            </div>
            <span className="rounded border border-rv-divider bg-rv-c3 px-1.5 py-px font-rv-mono text-[10px] text-rv-mute-700">
              {row.share}
            </span>
          </div>
        );
      })}
    </div>
  );
}
