import { useTranslation } from "react-i18next";
import type { CompositionSegment } from "./types";

type Props = {
  /** Free-text "updated 12s ago" timestamp shown on the right. */
  updatedLabel: string;
  /** Live segments from the API; empty until the first response lands. */
  segments?: ReadonlyArray<CompositionSegment>;
  /** Total override; falls back to summing `segments`. */
  total?: number;
};

/**
 * Proportional bar showing the share of every subscription state. The
 * legend underneath echoes the same colors and adds absolute counts.
 */
export function CompositionBar({ updatedLabel, segments, total }: Props) {
  const { t } = useTranslation();
  const data = segments ?? [];
  const totalCount = total ?? data.reduce((a, s) => a + s.count, 0);
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <h3 className="text-[14px] font-semibold">
            {t("subscriptions.composition.title")}
          </h3>
          <p className="mt-0.5 text-[12px] text-rv-mute-500">
            {t("subscriptions.composition.subtitle", {
              total: totalCount.toLocaleString(),
            })}
          </p>
        </div>
        <span className="font-rv-mono text-[12px] text-rv-mute-500">
          {updatedLabel}
        </span>
      </div>

      <div className="flex h-7 gap-0.5 overflow-hidden rounded">
        {data.length === 0 && <div className="flex-1 bg-rv-c3" />}
        {data.map((seg) => (
          <div
            key={seg.key}
            className="flex min-w-[40px] items-center justify-end px-2.5 font-rv-mono text-[11px] text-white/90 tabular-nums transition-[flex-grow] duration-200"
            style={{ flexGrow: seg.count, background: seg.color }}
          >
            {seg.count.toLocaleString()}
          </div>
        ))}
      </div>

      <ul className="mt-3.5 flex flex-wrap gap-x-6 gap-y-2">
        {data.map((seg) => (
          <li
            key={seg.key}
            className="flex items-center gap-2 text-[12px]"
          >
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-sm"
              style={{ background: seg.color }}
            />
            <span className="text-rv-mute-600">
              {t(`subscriptions.composition.segments.${seg.key}`)}
            </span>
            <span className="font-rv-mono text-foreground">
              {seg.count.toLocaleString()}
            </span>
            <span className="font-rv-mono text-[10px] text-rv-mute-500">
              {seg.share}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
