import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui-components/react/popover";
import { Check, ChevronsUpDown } from "lucide-react";
import type { TransactionsListSort } from "@rovenue/shared";
import { buttonVariants } from "../../ui/button";
import { cn } from "../../lib/cn";

type Props = {
  value: TransactionsListSort;
  onChange: (next: TransactionsListSort) => void;
};

const OPTIONS: ReadonlyArray<TransactionsListSort> = [
  "newest",
  "oldest",
  "amount_desc",
  "amount_asc",
];

const LABEL_KEY: Record<TransactionsListSort, string> = {
  newest: "transactions.sort.modes.newest",
  oldest: "transactions.sort.modes.oldest",
  amount_desc: "transactions.sort.modes.amount_desc",
  amount_asc: "transactions.sort.modes.amount_asc",
};

/**
 * Single-select dropdown bound to the URL `sort` param. Switching
 * the mode resets the cursor stack so the list lands back on page 1.
 */
export function TxSortPopover({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <Popover.Root>
      <Popover.Trigger
        className={cn(buttonVariants({ variant: "light", size: "sm" }))}
      >
        <ChevronsUpDown size={13} />
        {t("transactions.sort.label", { mode: t(LABEL_KEY[value]) })}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-50">
          <Popover.Popup className="w-[240px] rounded-lg border border-rv-divider-strong bg-rv-c3 py-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in">
            {OPTIONS.map((mode) => {
              const active = mode === value;
              return (
                <Popover.Close
                  key={mode}
                  render={
                    <button
                      type="button"
                      onClick={() => onChange(mode)}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition",
                        active
                          ? "text-[color-mix(in_srgb,var(--color-rv-accent-400)_85%,white)]"
                          : "text-rv-mute-700 hover:bg-rv-c4 hover:text-foreground",
                      )}
                    >
                      <span>{t(LABEL_KEY[mode])}</span>
                      {active && <Check size={12} />}
                    </button>
                  }
                />
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
