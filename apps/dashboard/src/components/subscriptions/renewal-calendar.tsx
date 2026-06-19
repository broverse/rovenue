import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { CalendarDay } from "./types";

const LEGEND: ReadonlyArray<{
  key: "renewals" | "trials" | "grace" | "failed";
  color: string;
}> = [
  { key: "renewals", color: "var(--color-rv-accent-500)" },
  { key: "trials",   color: "var(--color-rv-success)" },
  { key: "grace",    color: "var(--color-rv-warning)" },
  { key: "failed",   color: "var(--color-rv-danger)" },
];

function tooltipFor(d: CalendarDay, t: TFunction): string {
  if (d.past) {
    return t("subscriptions.calendar.tooltipPast", {
      day: -d.day,
      failed: d.failed,
    });
  }
  const total = d.renewals + d.trials + d.grace + d.failed;
  if (d.today) return t("subscriptions.calendar.tooltipToday", { total });
  return t("subscriptions.calendar.tooltipFuture", { day: d.day, total });
}

type RenewalCalendarProps = {
  /** Per-day buckets from the renewal-calendar API. */
  days?: ReadonlyArray<CalendarDay>;
};

/**
 * Stacked-bar calendar. Today is rendered with a dashed primary marker;
 * past slots only carry failed-event counts.
 */
export function RenewalCalendar({ days }: RenewalCalendarProps = {}) {
  const { t } = useTranslation();
  const data = days ?? [];
  const maxTotal = Math.max(
    1,
    ...data.map((d) => d.renewals + d.trials + d.grace + d.failed),
  );
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-semibold">
            {t("subscriptions.calendar.title")}
          </h3>
          <p className="mt-0.5 text-[12px] text-rv-mute-500">
            {t("subscriptions.calendar.subtitle")}
            <span className="ml-1 text-rv-accent-400">●</span>
            <span className="ml-1">{t("subscriptions.calendar.today")}</span>
          </p>
        </div>
        <ul className="flex flex-wrap gap-3.5 text-[11px] text-rv-mute-500">
          {LEGEND.map((l) => (
            <li key={l.key} className="inline-flex items-center gap-1.5">
              <span
                className="size-2 rounded-sm"
                style={{ background: l.color }}
                aria-hidden="true"
              />
              {t(`subscriptions.calendar.legend.${l.key}`)}
            </li>
          ))}
        </ul>
      </div>

      <div
        className="grid h-[120px] items-end gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}
      >
        {data.map((d, i) => {
          const total = d.renewals + d.trials + d.grace + d.failed;
          const heightPct = Math.max(4, (total / maxTotal) * 100);
          return (
            <div
              key={i}
              className="group relative flex cursor-pointer flex-col justify-end gap-px rounded-t-[3px]"
              style={{ height: `${heightPct}%` }}
            >
              {d.today && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-1 -bottom-[22px] left-0 border-l border-dashed border-rv-accent-500/60"
                />
              )}
              <span
                role="tooltip"
                className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-10 -translate-x-1/2 translate-y-1 whitespace-nowrap rounded border border-rv-divider bg-rv-c4 px-2.5 py-1.5 font-rv-mono text-[10px] text-foreground opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100"
              >
                {tooltipFor(d, t)}
              </span>
              {d.failed > 0 && (
                <span
                  className="block w-full rounded-sm bg-rv-danger/80"
                  style={{ flex: d.failed }}
                />
              )}
              {d.grace > 0 && (
                <span
                  className="block w-full rounded-sm bg-rv-warning"
                  style={{ flex: d.grace }}
                />
              )}
              {d.trials > 0 && (
                <span
                  className="block w-full rounded-sm bg-rv-success"
                  style={{ flex: d.trials }}
                />
              )}
              {d.renewals > 0 && (
                <span
                  className={cn(
                    "block w-full rounded-sm",
                    d.today
                      ? "bg-rv-accent-400 ring-1 ring-rv-accent-500/50"
                      : "bg-rv-accent-500",
                  )}
                  style={{ flex: d.renewals }}
                />
              )}
            </div>
          );
        })}
      </div>

      <div
        className="mt-1.5 grid gap-[3px] font-rv-mono text-[9px] text-rv-mute-500"
        style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}
      >
        {data.map((d, i) => (
          <span
            key={i}
            className={cn(
              "text-center",
              d.today && "text-rv-accent-400",
            )}
          >
            {i % 3 === 0
              ? d.today
                ? t("subscriptions.calendar.today")
                : `${d.day >= 0 ? "+" : ""}${d.day}d`
              : ""}
          </span>
        ))}
      </div>
    </section>
  );
}
