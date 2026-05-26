import { useTranslation } from "react-i18next";
import type { CohortRow } from "@rovenue/shared";
import { dotColorForId } from "./format";

type Props = {
  cohort: CohortRow;
  size: number | null;
  w4Pct: number | null;
};

function HeroStat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div className="mt-0.5 font-rv-mono text-[24px] font-medium tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

export function CohortHero({ cohort, size, w4Pct }: Props) {
  const { t } = useTranslation();
  const sizeDisplay = size == null ? "—" : size.toLocaleString();
  const w4Display = w4Pct == null ? "—" : `${w4Pct.toFixed(1)}%`;

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="flex flex-wrap justify-between gap-5">
        <div className="min-w-[280px] flex-1">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ background: dotColorForId(cohort.id) }}
            />
            {t("cohorts.hero.groupCohort", {
              group: t("cohorts.hero.defaultGroup"),
            })}
          </div>
          <h2 className="mt-1.5 mb-1 text-[22px] font-semibold leading-tight">
            {cohort.name}
          </h2>
          {cohort.description && (
            <p className="m-0 text-[13px] text-rv-mute-600">
              {cohort.description}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-start gap-6">
          <HeroStat label={t("cohorts.hero.size")} value={sizeDisplay} />
          <HeroStat
            label={t("cohorts.hero.w4Retention")}
            value={w4Display}
          />
        </div>
      </div>
    </section>
  );
}
