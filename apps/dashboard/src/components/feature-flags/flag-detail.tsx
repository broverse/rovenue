import { useTranslation } from "react-i18next";
import { ChangeLog } from "./change-log";
import { CodeSnippet } from "./code-snippet";
import { EvaluationStrip } from "./evaluation-strip";
import { FlagToggle } from "./flag-toggle";
import { KillBanner } from "./kill-banner";
import { RuleCard } from "./rule-card";
import { TagPill } from "./tag-pill";
import { TypeBadge } from "./type-badge";
import { VariantSplit } from "./variant-split";
import type { FeatureFlag } from "./types";

type Props = {
  flag: FeatureFlag;
  seed: number;
  onToggle: () => void;
};

export function FlagDetail({ flag, seed, onToggle }: Props) {
  const { t } = useTranslation();

  return (
    <aside className="sticky top-[76px] max-h-[calc(100vh-96px)] overflow-y-auto rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-start gap-2.5 border-b border-rv-divider px-5 py-4">
        <TypeBadge type={flag.type} size="md" className="shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-rv-mono text-[15px] font-semibold">
            {flag.key}
          </h2>
          <p className="mt-1 text-[12px] text-rv-mute-600">{flag.description}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            <TagPill tone={flag.env === "prod" ? "env-prod" : "env-staging"}>
              {flag.env}
            </TagPill>
            <TagPill>
              {t("featureFlags.detail.typeLabel", { type: flag.type })}
            </TagPill>
            {flag.linkedExperiment && (
              <TagPill tone="linked-experiment">
                {t("featureFlags.row.expPrefix")} {flag.linkedExperiment}
              </TagPill>
            )}
            {flag.tags.map((tag) => (
              <TagPill key={tag}>{tag}</TagPill>
            ))}
          </div>
        </div>
        <FlagToggle
          enabled={flag.enabled}
          killed={flag.killed}
          onToggle={onToggle}
          size="md"
          className="mt-1"
        />
      </header>

      {flag.killed && (
        <div className="px-5 pt-4">
          <KillBanner onReenable={onToggle} />
        </div>
      )}

      <section className="border-b border-rv-divider px-5 py-4">
        <EvaluationStrip
          evalRate={flag.evalRate}
          evals24h={flag.evals24h}
          killed={flag.killed}
          seed={seed}
        />
        {flag.variants && (
          <div className="mt-3">
            <SectionHeading
              title={t("featureFlags.detail.variantSplit")}
              count={t("featureFlags.detail.variantCount", {
                count: flag.variants.length,
              })}
            />
            <VariantSplit variants={flag.variants} />
          </div>
        )}
      </section>

      <section className="border-b border-rv-divider px-5 py-4">
        <SectionHeading
          title={t("featureFlags.detail.targeting")}
          count={t("featureFlags.detail.ruleCount", {
            count: flag.rules.length,
          })}
        />
        <div className="flex flex-col gap-2">
          {flag.rules.map((rule, i) => (
            <RuleCard key={i} rule={rule} index={i} />
          ))}
        </div>
      </section>

      <section className="border-b border-rv-divider px-5 py-4">
        <SectionHeading
          title={t("featureFlags.detail.sdkUsage")}
          count={t("featureFlags.detail.copyHint")}
        />
        <CodeSnippet flag={flag} />
      </section>

      <section className="px-5 py-4">
        <SectionHeading
          title={t("featureFlags.detail.changelog")}
          count={t("featureFlags.detail.eventCount", {
            count: flag.history.length,
          })}
        />
        <ChangeLog entries={flag.history} />
      </section>
    </aside>
  );
}

function SectionHeading({ title, count }: { title: string; count?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
      <span>{title}</span>
      {count && (
        <span className="font-rv-mono text-[10px] normal-case tracking-normal text-rv-mute-400">
          {count}
        </span>
      )}
    </div>
  );
}
