import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { formatCount, formatDelta, initials } from "./format";
import { ScopeTabs } from "./scope-tabs";
import { SourceBadge } from "./source-badge";
import type { LedgerEntry, LedgerScope } from "./types";

type Props = {
  entries: ReadonlyArray<LedgerEntry>;
  /** Unfiltered total — drives the "{visible} of {total}" header counter. */
  total: number;
  scope: LedgerScope;
  onScopeChange: (next: LedgerScope) => void;
  onSelect?: (entryId: string) => void;
};

/**
 * Live ledger card — header with filter pills and "{visible} of {total}"
 * counter, then a sticky-header table of credit movements. Δ credits
 * are colored green for positive, neutral for negative; balance trails
 * in muted text.
 */
export function LedgerTable({ entries, total, scope, onScopeChange, onSelect }: Props) {
  const { t } = useTranslation();
  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-rv-divider px-3.5 py-3">
        <h3 className="text-[14px] font-semibold">{t("credits.ledger.title")}</h3>
        <span className="font-rv-mono text-[11px] text-rv-mute-500">
          {t("credits.ledger.count", {
            visible: entries.length,
            total,
          })}
        </span>
        <div className="ml-auto">
          <ScopeTabs value={scope} onChange={onScopeChange} />
        </div>
      </header>
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <Th className="w-[88px]">{t("credits.ledger.cols.time")}</Th>
              <Th className="w-[220px]">{t("credits.ledger.cols.user")}</Th>
              <Th className="w-[110px]">{t("credits.ledger.cols.source")}</Th>
              <Th className="min-w-[220px]">{t("credits.ledger.cols.note")}</Th>
              <Th className="w-[80px]">{t("credits.ledger.cols.currency")}</Th>
              <Th className="w-[100px] text-right">{t("credits.ledger.cols.delta")}</Th>
              <Th className="w-[100px] text-right">{t("credits.ledger.cols.balance")}</Th>
              <Th className="w-[60px]">
                <span className="sr-only">{t("credits.ledger.cols.actions")}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="py-12 text-center font-rv-mono text-[12px] text-rv-mute-500"
                >
                  {t("credits.ledger.empty")}
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-white/[0.04] transition hover:bg-rv-c2"
                >
                  <td className="px-3 py-3 align-middle font-rv-mono text-[11px] text-rv-mute-500">
                    {entry.ts}
                  </td>
                  <td className="px-3 py-3 align-middle">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full font-rv-mono text-[9px] font-semibold text-white"
                        style={{ background: entry.avatarColor }}
                      >
                        {initials(entry.user)}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate">{entry.user}</div>
                        <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">
                          {entry.uid}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 align-middle">
                    <SourceBadge source={entry.source} />
                  </td>
                  <td className="px-3 py-3 align-middle">
                    <div className="font-rv-mono text-[12px]">{entry.note}</div>
                    {entry.extId ? (
                      <div className="mt-0.5 font-rv-mono text-[10px] text-rv-mute-500">
                        {entry.extId}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 align-middle font-rv-mono text-[11px] text-rv-mute-300">
                    {entry.currencyCode}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-3 text-right align-middle font-rv-mono tabular-nums",
                      entry.delta > 0
                        ? "font-medium text-rv-success"
                        : "text-rv-mute-700",
                    )}
                  >
                    {formatDelta(entry.delta)}
                  </td>
                  <td className="px-3 py-3 text-right align-middle font-rv-mono text-[11px] tabular-nums text-rv-mute-500">
                    {formatCount(entry.balance)}
                  </td>
                  <td className="px-3 py-3 text-right align-middle">
                    <Button
                      variant="icon-light"
                      size="icon"
                      className="size-6"
                      aria-label={t("credits.ledger.cols.actions")}
                      onClick={() => onSelect?.(entry.id)}
                    >
                      <ChevronRight size={12} />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "sticky top-0 z-[1] whitespace-nowrap border-b border-rv-divider bg-rv-c2 px-3 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-rv-mute-500",
        className,
      )}
    >
      {children}
    </th>
  );
}
