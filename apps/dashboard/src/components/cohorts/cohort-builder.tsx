import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import type { CohortFilter, CohortRow } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { QueryChip } from "./query-chip";

type Props = {
  projectId: string;
  cohort: CohortRow;
  matchCount: number | null;
  refreshedLabel: string;
};

function describeValue(f: CohortFilter): string {
  if (Array.isArray(f.value)) return `[${f.value.join(", ")}]`;
  if (typeof f.value === "object" && f.value !== null && "min" in f.value)
    return `${f.value.min}–${f.value.max}`;
  return String(f.value);
}

export function CohortDefinitionCard({
  projectId,
  cohort,
  matchCount,
  refreshedLabel,
}: Props) {
  const { t } = useTranslation();
  const filters = cohort.rules.filters;
  const join =
    cohort.rules.match === "any"
      ? t("cohorts.builder.or")
      : t("cohorts.builder.and");

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <header className="mb-3 flex items-center justify-between">
        <h4 className="m-0 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("cohorts.builder.heading")}
        </h4>
        <div className="flex gap-1.5">
          <Link
            to="/projects/$projectId/cohorts/$cohortId"
            params={{ projectId, cohortId: cohort.id }}
          >
            <Button variant="flat" size="sm" className="h-[26px]">
              {t("cohorts.builder.edit")}
            </Button>
          </Link>
        </div>
      </header>

      {filters.length === 0 ? (
        <p className="m-0 text-[12px] text-rv-mute-500">
          {t("cohorts.builder.noFilters")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {filters.map((f, idx) => (
            <span key={`${f.field}-${idx}`} className="contents">
              <QueryChip
                attribute={t(`cohorts.form.rules.field.${f.field}`)}
                op={t(`cohorts.form.rules.op.${f.op}`)}
                value={describeValue(f)}
              />
              {idx < filters.length - 1 && (
                <span className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
                  {join}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 text-right font-rv-mono text-[11px] text-rv-mute-500">
        {matchCount == null
          ? t("cohorts.builder.matchesUnknown")
          : t("cohorts.builder.matches", {
              count: matchCount.toLocaleString(),
              ago: refreshedLabel,
            })}
      </div>
    </section>
  );
}
