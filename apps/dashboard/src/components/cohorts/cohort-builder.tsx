import { Trans, useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { Button } from "../../ui/button";
import { AddConditionChip, QueryChip } from "./query-chip";
import { EXCLUDE_CONDITIONS, INCLUDE_CONDITIONS } from "./mock-data";

type Props = {
  matchCount: number;
};

export function CohortBuilder({ matchCount }: Props) {
  const { t } = useTranslation();

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <header className="mb-3 flex items-center justify-between">
        <h4 className="m-0 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("cohorts.builder.heading")}
        </h4>
        <div className="flex gap-1.5">
          <Button variant="flat" size="sm" className="h-[26px]">
            <Copy size={12} />
            {t("cohorts.actions.duplicate")}
          </Button>
          <Button variant="flat" size="sm" className="h-[26px]">
            <Check size={12} />
            {t("cohorts.actions.save")}
          </Button>
        </div>
      </header>

      <BuilderRow label={t("cohorts.builder.include")}>
        {INCLUDE_CONDITIONS.map((c, idx) => (
          <span key={c.attribute} className="contents">
            <QueryChip attribute={c.attribute} op={c.op} value={c.value} onRemove={() => {}} />
            {idx < INCLUDE_CONDITIONS.length - 1 && (
              <span className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("cohorts.builder.and")}
              </span>
            )}
          </span>
        ))}
        <AddConditionChip>{t("cohorts.builder.addCondition")}</AddConditionChip>
      </BuilderRow>

      <BuilderRow label={t("cohorts.builder.exclude")}>
        {EXCLUDE_CONDITIONS.map((c) => (
          <QueryChip
            key={c.attribute + c.value}
            attribute={c.attribute}
            op={c.op}
            value={c.value}
            trailing={c.trailing}
            onRemove={() => {}}
          />
        ))}
        <AddConditionChip>{t("cohorts.builder.addCondition")}</AddConditionChip>
      </BuilderRow>

      <BuilderRow label={t("cohorts.builder.anchor")}>
        <QueryChip op={t("cohorts.builder.cohortBy")} value={t("cohorts.builder.anchorValue")} />
        <QueryChip op={t("cohorts.builder.bucket")} value={t("cohorts.builder.bucketValue")} />
        <span className="ml-auto font-rv-mono text-[11px] text-rv-mute-500">
          <Trans
            i18nKey="cohorts.builder.matches"
            values={{ count: matchCount.toLocaleString(), ago: t("cohorts.builder.refreshedAgo") }}
            components={[<span key="0" className="font-medium text-foreground" />]}
          />
        </span>
      </BuilderRow>
    </section>
  );
}

function BuilderRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-2 last:mb-0">
      <span className="w-20 shrink-0 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </span>
      {children}
    </div>
  );
}
