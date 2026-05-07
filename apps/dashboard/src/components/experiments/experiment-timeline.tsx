import { useTranslation } from "react-i18next";
import { timelineDotColor } from "./format";
import type { TimelineEntry } from "./types";

type Props = {
  entries: ReadonlyArray<TimelineEntry>;
};

/**
 * Vertical event timeline — one row per entry, mono "when" column,
 * tonal dot, then bold title + grey sub. The connecting line is drawn
 * on every row except the last so dots chain together.
 */
export function ExperimentTimeline({ entries }: Props) {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <h3 className="m-0 mb-3 text-[14px] font-semibold">
        {t("experiments.timeline.title")}
      </h3>
      {entries.map((entry, i) => {
        const isLast = i === entries.length - 1;
        const when = entry.whenValues
          ? t(entry.whenKey, entry.whenValues)
          : t(entry.whenKey);
        return (
          <div
            key={`${entry.titleKey}-${i}`}
            className="grid grid-cols-[120px_14px_1fr] items-start gap-3 py-2 text-[12px]"
          >
            <div className="font-rv-mono text-[11px] text-rv-mute-500">{when}</div>
            <div className="flex flex-col items-center">
              <span
                className="mt-[3px] size-2 rounded-full"
                style={{ background: timelineDotColor(entry.tone) }}
              />
              {!isLast && <span className="mt-0.5 min-h-[14px] w-px flex-1 bg-rv-divider" />}
            </div>
            <div>
              <div className="font-medium text-foreground">{t(entry.titleKey)}</div>
              <div className="mt-0.5 text-[11px] text-rv-mute-500">{t(entry.subKey)}</div>
            </div>
          </div>
        );
      })}
    </section>
  );
}
