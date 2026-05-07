import { useTranslation } from "react-i18next";
import { dotColor } from "./format";
import type { CohortMember, SavedCohort } from "./types";

type Props = {
  cohort: SavedCohort;
  members: ReadonlyArray<CohortMember>;
};

type StatProps = {
  label: string;
  value: string;
  delta: string;
  deltaTone: "success" | "danger";
};

function HeroStat({ label, value, delta, deltaTone }: StatProps) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div className="mt-0.5 font-rv-mono text-[24px] font-medium tabular-nums text-foreground">
        {value}
      </div>
      <div
        className={
          "font-rv-mono text-[11px] " +
          (deltaTone === "danger" ? "text-rv-danger" : "text-rv-success")
        }
      >
        {delta}
      </div>
    </div>
  );
}

export function CohortHero({ cohort, members }: Props) {
  const { t } = useTranslation();
  const negative = cohort.growth.startsWith("−");
  const remainder = cohort.size - members.length;

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="flex flex-wrap justify-between gap-5">
        <div className="min-w-[280px] flex-1">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ background: dotColor(cohort.dot) }}
            />
            {t("cohorts.hero.groupCohort", { group: cohort.group })}
          </div>
          <h2 className="mt-1.5 mb-1 text-[22px] font-semibold leading-tight">
            {cohort.name}
          </h2>
          <p className="m-0 text-[13px] text-rv-mute-600">{cohort.description}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {members.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-rv-divider bg-rv-c2 py-1 pr-2 pl-1 font-rv-mono text-[11px] text-rv-mute-700"
              >
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-gradient-to-br from-rv-accent-600 to-rv-violet text-[9px] font-semibold text-white">
                  {m.initials}
                </span>
                {m.id}
              </span>
            ))}
            {remainder > 0 && (
              <span className="inline-flex items-center rounded-full border border-rv-divider bg-rv-c2 px-2.5 py-1 font-rv-mono text-[11px] text-rv-mute-500">
                {t("cohorts.hero.memberMore", { count: remainder.toLocaleString() })}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-6">
          <HeroStat
            label={t("cohorts.hero.size")}
            value={cohort.size.toLocaleString()}
            delta={t("cohorts.hero.sizeDelta", { value: cohort.growth })}
            deltaTone={negative ? "danger" : "success"}
          />
          <HeroStat
            label={t("cohorts.hero.w4Retention")}
            value={t("cohorts.hero.w4RetentionValue")}
            delta={t("cohorts.hero.w4RetentionDelta")}
            deltaTone="success"
          />
          <HeroStat
            label={t("cohorts.hero.ltv90")}
            value={t("cohorts.hero.ltv90Value")}
            delta={t("cohorts.hero.ltv90Delta")}
            deltaTone="success"
          />
          <HeroStat
            label={t("cohorts.hero.monthlyChurn")}
            value={t("cohorts.hero.monthlyChurnValue")}
            delta={t("cohorts.hero.monthlyChurnDelta")}
            deltaTone="success"
          />
        </div>
      </div>
    </section>
  );
}
