import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { LedgerScope } from "./types";

const SCOPES: ReadonlyArray<LedgerScope> = [
  "all",
  "purchase",
  "consume",
  "bonus",
  "refund",
  "adjust",
  "expire",
];

type Props = {
  value: LedgerScope;
  onChange: (next: LedgerScope) => void;
};

/**
 * Pill-style filter row above the ledger table. Mirrors the design's
 * mono filter chips — active pill picks up the accent tint, others
 * sit on rv-c2.
 */
export function ScopeTabs({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <div role="tablist" aria-label="ledger-scope" className="flex flex-wrap gap-1.5">
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
              "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded border px-2.5 font-rv-mono text-[11px] transition",
              active
                ? "border-rv-accent-500/30 bg-rv-accent-500/14 text-rv-accent-400"
                : "border-rv-divider bg-rv-c2 text-rv-mute-600 hover:border-rv-divider-strong hover:text-foreground",
            )}
          >
            {t(`credits.scope.${scope}`)}
          </button>
        );
      })}
    </div>
  );
}
