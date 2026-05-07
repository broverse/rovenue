import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { SCOPE_TOTAL_COUNTS } from "./mock-data";
import type { TxScope } from "./types";

const SCOPES: ReadonlyArray<TxScope> = ["all", "purchase", "renewal", "refund", "trial", "failed"];

type Props = {
  value: TxScope;
  onChange: (next: TxScope) => void;
};

/**
 * Segmented scope tabs sitting above the transactions table — same look
 * as the subscribers page but with transaction-shaped labels and counts.
 * Counts are display-only constants pulled from `mock-data`.
 */
export function ScopeTabs({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label="scope"
      className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-[3px]"
    >
      {SCOPES.map((scope) => {
        const active = value === scope;
        return (
          <button
            key={scope}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(scope)}
            className={cn(
              "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded px-3 text-[12px] transition",
              active
                ? "bg-rv-c4 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.05)]"
                : "text-rv-mute-600 hover:text-foreground",
            )}
          >
            {t(`transactions.scope.${scope}`)}
            <span
              className={cn(
                "rounded-[3px] px-1 py-px font-rv-mono text-[10px] tabular-nums",
                active ? "bg-rv-c2 text-rv-mute-700" : "bg-rv-c3 text-rv-mute-500",
              )}
            >
              {SCOPE_TOTAL_COUNTS[scope]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
